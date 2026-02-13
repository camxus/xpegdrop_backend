import { SQSHandler } from "aws-lambda";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { DropboxService } from "../../../lib/dropbox";
import { BackblazeService } from "../../../lib/backblaze"; // Your B2 wrapper
import { getItemFile } from "../../../utils/s3";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv"
import { allowedVideoTypes, createThumbnailFromFile, transcodeVideoToMp4 } from "../../../utils/file-utils";
import { createProjectHistoryItem } from "../../../controllers/historyController";
import { ProjectHistoryType } from "../../../types";
// import { GoogleDriveService } from "../../../lib/google";

dotenv.config()

const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || "Projects";
const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });
const B2_BUCKET_ID = process.env.EXPRESS_B2_BUCKET_ID || "";

const THUMBNAILS_BUCKET = process.env.EXPRESS_S3_THUMBNAILS_BUCKET || "";
const B2_TRANSCODED_MEDIA_BUCKET_ID = process.env.EXPRESS_B2_TRANSCODED_MEDIA_BUCKET_ID!;

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const data = JSON.parse(record.body);
    const { user, project, files, file_locations, tenant, storage_provider: storageProvider } = data;

    let folderPath: string | null = null;
    let shareLink = "";

    try {
      // Helper to fetch files from S3 or reconstruct from buffers
      const getFiles = async (): Promise<File[]> => {
        if (files.length) {
          return files.map((f: any) => {
            const buf = Buffer.from(f.buffer, "base64");
            const blob = new Blob([buf], { type: f.mimetype });
            return new File([blob], f.originalname, { type: f.mimetype });
          });
        }

        if (file_locations.length) {
          return await Promise.all(
            file_locations.map(async (location: any) => {
              const file = await getItemFile(s3Client, location);
              return file.file;
            })
          );
        }

        return [];
      };

      const uploadFiles = await getFiles();
      const folderName = project.name;

      if (storageProvider === "dropbox") {
        if (!user.dropbox?.access_token) throw new Error("Dropbox access token missing");
        const dropboxService = new DropboxService(user.dropbox.access_token, tenant?.tenant_id);

        try {
          const response = await dropboxService.upload(uploadFiles, folderName);
          folderPath = response.folder_path;
          shareLink = response.share_link;
        } catch (err: any) {
          if (err?.status === 401 && user.dropbox.refresh_token) {
            await dropboxService.refreshDropboxToken(user);
            const response = await dropboxService.upload(uploadFiles, folderName);
            folderPath = response.folder_path;
            shareLink = response.share_link;
          } else {
            throw err;
          }
        }
        // } else if (storageProvider === "google") {
        //   if (!user.google?.access_token) throw new Error("Google access token missing");
        //   const googleService = new GoogleDriveService(user.google.access_token);

        //   try {
        //     const response = await googleService.upload(uploadFiles, folderName);
        //     folderPath = response.folder_id;
        //     shareLink = response.share_link;
        //   } catch (err: any) {
        //     if (err?.status === 401 && user.google.refresh_token) {
        //       await googleService.refreshGoogleToken(user);
        //       const response = await googleService.upload(uploadFiles, folderName);
        //       folderPath = response.folder_id;
        //       shareLink = response.share_link;
        //     } else {
        //       throw err;
        //     }
        //   }
      } else if (storageProvider === "b2") {
        const b2Service = new BackblazeService(B2_BUCKET_ID, user.user_id, tenant?.tenant_id);

        const storageUsage = await b2Service.getStorageSpaceUsage()

        const uploadSize = uploadFiles.reduce((acc: number, file: File) => acc + file.size, 0);

        if (storageUsage.allocated < storageUsage.used + uploadSize) {
          // Not enough space to upload files
          throw new Error(`Upload exceeds allocated storage`);
        }

        const response = await b2Service.upload(uploadFiles, folderName);
        folderPath = response.folder_path;
        shareLink = response.share_link;

        // --- CREATE THUMBNAILS AND UPLOAD TO S3 ---
        for (const file of uploadFiles) {
          if (allowedVideoTypes.includes(file.type)) {
            const transcodedService = new BackblazeService(
              B2_TRANSCODED_MEDIA_BUCKET_ID!,
              user.user_id!,
              tenant?.tenant_id
            );

            const transcodedFileName = `${folderPath}/${file.name.replace(/\.\w+$/, ".mp4")}`;
            await transcodedService.authorize();

            const existingFiles = await transcodedService.listFiles(folderPath);
            const exists = existingFiles.some((f) => f.name === transcodedFileName);

            if (exists) await transcodedService.deleteFile(folderPath, transcodedFileName);

            const transcodedBuffer = await transcodeVideoToMp4(Buffer.from(await file.arrayBuffer()));

            await transcodedService.uploadBuffer(transcodedBuffer, folderPath)
          }

          try {
            const thumbnailBuffer = await createThumbnailFromFile(file);
            const thumbnailKey = `${b2Service.getPrefix(folderName)}/${file.name}`;

            const putCommand = new PutObjectCommand({
              Bucket: THUMBNAILS_BUCKET,
              Key: thumbnailKey,
              Body: thumbnailBuffer,
              ContentType: "image/jpeg",
              StorageClass: "INTELLIGENT_TIERING", // S3 Intelligent-Tiering
            });

            await s3Client.send(putCommand);
          } catch (e) {
            throw e;
          }
        }
      } else {
        throw new Error(`Unsupported storage provider: ${storageProvider}`);
      }

      // Determine provider-specific attributes
      const folderAttr =
        storageProvider === "dropbox"
          ? "dropbox_folder_path"
          : storageProvider === "b2"
            ? "b2_folder_path"
            : storageProvider === "google"
              ? "google_folder_id"
              : null;

      const linkAttr =
        storageProvider === "dropbox"
          ? "dropbox_shared_link"
          : storageProvider === "b2"
            ? "b2_shared_link"
            : storageProvider === "google"
              ? "google_shared_link"
              : null;

      // Update DynamoDB with provider-specific folder path and share link
      const updateExpr = `SET ${folderAttr} = :folder, ${linkAttr} = :link, #st = :status`;
      const params = new UpdateItemCommand({
        TableName: PROJECTS_TABLE,
        Key: marshall({ project_id: project.project_id }),
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: { "#st": "status" }, // because "status" is reserved
        ExpressionAttributeValues: marshall({
          ":folder": folderPath,
          ":link": shareLink,
          ":status": "created",
        }),
        ReturnValues: "ALL_NEW",
      });


      await createProjectHistoryItem<ProjectHistoryType.PROJECT_CREATED>({
        project_id: project.project_id,
        actor_id: user?.user_id,
        type: ProjectHistoryType.PROJECT_CREATED,
      });


      await client.send(params);
      console.log(`✅ Project ${project.project_id} created successfully.`);
    } catch (err) {
      console.error("❌ Project worker failed:", err);

      // Mark project as failed in DynamoDB
      try {
        const failParams = new UpdateItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id: project.project_id }),
          UpdateExpression: "SET #st = :status REMOVE share_url",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: marshall({ ":status": "failed" }),
        });
        await client.send(failParams);
      } catch (updateErr) {
        console.error("❌ Failed to update project status to failed:", updateErr);
      }

      // Cleanup partially created folder
      if (folderPath) {
        try {
          if (storageProvider === "dropbox" && user.dropbox?.access_token) {
            const dropboxService = new DropboxService(user.dropbox.access_token);
            await dropboxService.deleteFolder(folderPath);
            console.log(`🗑️ Deleted Dropbox folder ${folderPath} after failure.`);
            // } else if (storageProvider === "google" && user.google?.access_token) {
            //   const googleService = new GoogleDriveService(user.google.access_token);
            //   await googleService.deleteFolder(folderPath);
            console.log(`🗑️ Deleted Google Drive folder ${folderPath} after failure.`);
          } else if (storageProvider === "b2") {
            const b2Service = new BackblazeService(B2_BUCKET_ID, user.user_id, tenant?.tenant_id);
            await b2Service.deleteFolder(folderPath);
            console.log(`🗑️ Deleted B2 folder ${folderPath} after failure.`);
          }
        } catch (cleanupErr) {
          console.error("❌ Failed to delete folder after failure:", cleanupErr);
        }
      }
    }
  }
};
