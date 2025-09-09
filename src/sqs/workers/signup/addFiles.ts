import { SQSHandler } from "aws-lambda";
import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DropboxService } from "../../../utils/dropbox";
import { copyItemImage, getItemFile } from "../../../utils/s3";

const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || "Projects";
const REGION = process.env.AWS_REGION_CODE;
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;
const ADD_FILES_CLEANUP_QUEUE = "add-files-cleanup-queue";

const client = new DynamoDBClient({ region: REGION });
const s3Client = new S3Client({ region: REGION });
const sqsClient = new SQSClient({ region: REGION });

const enqueueCleanup = async (payload: any) => {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: `https://sqs.${REGION}.amazonaws.com/${ACCOUNT_ID}/${ADD_FILES_CLEANUP_QUEUE}`,
      MessageBody: JSON.stringify(payload),
    })
  );
};

// helper to read S3 object as JSON
const readS3Json = async (bucket: string, key: string) => {
  const obj = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await obj.Body?.transformToString();
  if (!body) throw new Error("S3 object empty");
  return JSON.parse(body);
};

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    let data: any = JSON.parse(record.body);

    // If message is S3 reference, fetch full payload from S3
    if (data.key && data.bucket) {
      data = await readS3Json(data.bucket, data.key);
    }

    const { projectId, files, user } = data;

    let uploadedFiles: any[] = [];

    try {
      // Fetch project
      const getRes = await client.send(
        new GetItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id: projectId }),
        })
      );

      if (!getRes.Item) {
        throw new Error(`Project not found: ${projectId}`);
      }

      const project = unmarshall(getRes.Item);

      if (project.user_id !== user.user_id) {
        throw new Error("Unauthorized: user mismatch");
      }

      if (!user.dropbox?.access_token) {
        throw new Error("Dropbox access token missing");
      }

      const dropboxService = new DropboxService(user.dropbox.access_token);;

      for (const file of files) {
        try {
          const destination = await getItemFile(
            s3Client,
            { bucket: file.bucket, key: file.key },
          );

          await s3Client.send(
            new DeleteObjectCommand({ Bucket: process.env.EXPRESS_S3_TEMP_BUCKET!, Key: file.key })
          );

          const uploadRes = await dropboxService.uploadFile(
            project.dropbox_folder_path,
            file.name,
            destination.buffer,
          );
          uploadedFiles.push({
            name: file.name,
            path: project.dropbox_folder_path,
            id: uploadRes.id,
          });
        } catch (err: any) {
          console.error("Dropbox upload failed", err);
          throw new Error(`Failed to upload ${file.name}`);
        }
      }

      console.log(`Files added successfully to project ${projectId}`, uploadedFiles);
    } catch (err) {
      console.error("Add files worker failed, enqueueing cleanup:", err);

      await enqueueCleanup({
        projectId,
        uploadedFiles,
        userId: user?.user_id,
      });

      throw err;
    }
  }
};
