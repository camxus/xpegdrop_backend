import { SQSHandler } from "aws-lambda";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || "Projects";
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });

/**
 * Expected cleanup payload shape:
 * {
 *   projectId: string;
 *   fileKeys?: string[]; // S3 keys to delete
 *   dynamoFileIds?: string[]; // file IDs to remove from DynamoDB
 * }
 */
export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const payload = JSON.parse(record.body);
    const { projectId, fileKeys, dynamoFileIds } = payload;

    console.log("Processing add-files-cleanup for:", payload);

    try {
      // Remove uploaded S3 files if present
      if (fileKeys && fileKeys.length) {
        for (const key of fileKeys) {
          try {
            await s3Client.send(
              new DeleteObjectCommand({
                Bucket: process.env.EXPRESS_S3_APP_BUCKET!,
                Key: key,
              })
            );
            console.log("Deleted file from S3:", key);
          } catch (err) {
            console.error("Failed to delete S3 object:", key, err);
          }
        }
      }

      // Remove DynamoDB file references if present
      if (dynamoFileIds && dynamoFileIds.length) {
        for (const fileId of dynamoFileIds) {
          try {
            await dynamoClient.send(
              new DeleteItemCommand({
                TableName: PROJECTS_TABLE,
                Key: marshall({
                  project_id: projectId,
                  file_id: fileId,
                }),
              })
            );
            console.log("Deleted file reference from DynamoDB:", fileId);
          } catch (err) {
            console.error("Failed to delete DynamoDB item:", fileId, err);
          }
        }
      }
    } catch (err) {
      console.error("Add-files-cleanup worker failed:", err);
      throw err; // Let Lambda/SQS retry
    }
  }
};
