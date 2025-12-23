import { SQSHandler } from "aws-lambda";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { DropboxService } from "../../../utils/dropbox";
import { BackblazeService } from "../../../utils/backblaze"; // Your B2 wrapper
import { getItemFile } from "../../../utils/s3";
import { S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv"

dotenv.config()

const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || "Projects";
const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });
const B2_BUCKET_ID = process.env.EXPRESS_B2_BUCKET_ID || "";

const updateProjectImagesMetadata = async (
  projectId: string,
  metadata: Record<string, any>
) => {
  const expressions: string[] = [];
  const exprNames: Record<string, string> = { "#images": "images" };
  const exprValues: Record<string, any> = {};

  let idx = 0;
  for (const [fileName, meta] of Object.entries(metadata)) {
    const key = `#img${idx}`;
    const value = `:meta${idx}`;
    expressions.push(`#images.${key}.metadata = ${value}`);
    exprNames[key] = fileName;
    exprValues[value] = meta;
    idx++;
  }

  if (!expressions.length) return;

  const updateExpr = `SET ${expressions.join(", ")}`;

  await client.send(
    new UpdateItemCommand({
      TableName: PROJECTS_TABLE,
      Key: marshall({ project_id: projectId }),
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: marshall(exprValues),
      ReturnValues: "ALL_NEW",
    })
  );
};

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const data = JSON.parse(record.body);
    const { user, project, files, file_locations, tenant, storage_provider: storageProvider, metadata } = data;

    let folderPath: string | null = null;
    let shareLink = "";

    try {
      // Helper to fetch files from S3 or reconstruct from buffers
      const getFiles = async () => {
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
      const folderName = tenant?.name ? `${tenant.name}/${project.name}` : project.name;

      if (storageProvider === "dropbox") {
        if (!user.dropbox?.access_token) throw new Error("Dropbox access token missing");
        const dropboxService = new DropboxService(user.dropbox.access_token);

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
      } else {
        throw new Error(`Unsupported storage provider: ${storageProvider}`);
      }

      if (metadata && Object.keys(metadata).length > 0) {
        await updateProjectImagesMetadata(project.project_id, metadata);
        console.log(`📝 Updated project ${project.project_id} images metadata.`);
      }

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
