import { SQSHandler } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
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
    const { user_id, username, dropbox } = user;

    try {
      const dropboxService = new DropboxService(dropbox.access_token);

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

      const { folder_path, share_link } = dropboxUploadResponse;

      // Build share URL
      const shareUrl = `${process.env.EXPRESS_PUBLIC_FRONTEND_URL}/${username}/${project.name
        .toLowerCase()
        .replace(/\s+/g, "-")}`;

      // Save to Dynamo
      const projectData = {
        project_id,
        user_id,
        name: project.name,
        description: project.description || null,
        share_url: shareUrl,
        is_public: true,
        approved_emails: [],
        dropbox_folder_path: folder_path,
        dropbox_shared_link: share_link,
        created_at: new Date().toISOString(),
      };

      await client.send(
        new PutItemCommand({
          TableName: PROJECTS_TABLE,
          Item: marshall(projectData),
        })
      );

      console.log(`✅ Project ${project_id} created successfully.`);
    } catch (err) {
      console.error("❌ Project worker failed:", err);
      // optionally: retry, dead-letter, or cleanup
    }
  }
};
