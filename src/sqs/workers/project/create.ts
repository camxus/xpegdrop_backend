import { SQSHandler } from "aws-lambda";

import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { DropboxService } from "../../../utils/dropbox";
import { getItemFile } from "../../../utils/s3";
import { S3Client } from "@aws-sdk/client-s3";

const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || "Projects";
const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const data = JSON.parse(record.body);

    const { project_id, user, project, files, file_locations } = data;
    const { dropbox } = user;

    const dropboxService = new DropboxService(dropbox.access_token);
    let folderPath: string | null = null;

    try {

      // Get files (rebuild buffers if needed)
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

      const dropboxFiles = await getFiles();

      let dropboxUploadResponse;
      try {
        dropboxUploadResponse = await dropboxService.upload(
          dropboxFiles,
          project.name
        );
      } catch (err: any) {
        if (err?.status === 401 && dropbox.refresh_token) {
          await dropboxService.refreshDropboxToken(user);
          dropboxUploadResponse = await dropboxService.upload(
            dropboxFiles,
            project.name
          );
        } else {
          throw err;
        }
      }


      folderPath = dropboxUploadResponse.folder_path
      const shareLink = dropboxUploadResponse.share_link

      // Save to Dynamo
      const projectData = {
        dropbox_folder_path: folderPath,
        dropbox_shared_link: shareLink,
        status: "created",
      };

      const params = new UpdateItemCommand({
        TableName: PROJECTS_TABLE,
        Key: marshall({ project_id }),
        UpdateExpression:
          "SET dropbox_folder_path = :folder, dropbox_shared_link = :link, #st = :status",
        ExpressionAttributeNames: {
          "#st": "status", // because "status" is a reserved word in DynamoDB
        },
        ExpressionAttributeValues: marshall({
          ":folder": projectData.dropbox_folder_path,
          ":link": projectData.dropbox_shared_link,
          ":status": projectData.status,
        }),
        ReturnValues: "ALL_NEW", // returns the updated item
      });

      await client.send(params);



      console.log(`✅ Project ${project_id} created successfully.`);
    } catch (err) {
      console.error("❌ Project worker failed:", err);
      // optionally: retry, dead-letter, or cleanup
      // Mark project as failed
      try {
        const params = new UpdateItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id }),
          UpdateExpression: "SET #st = :status REMOVE dropbox_shared_link",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: marshall({ ":status": "failed" }),
        });
        await client.send(params);
      } catch (updateErr) {
        console.error("❌ Failed to update project status to failed:", updateErr);
      }

      // Cleanup Dropbox folder if it was partially created
      if (folderPath) {
        try {
          await dropboxService.deleteFolder(folderPath);
          console.log(`🗑️ Deleted Dropbox folder ${folderPath} after failure.`);
        } catch (cleanupErr) {
          console.error("❌ Failed to delete Dropbox folder after failure:", cleanupErr);
        }
      }
    }
  }
};
