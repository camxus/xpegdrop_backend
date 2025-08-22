import { SQSHandler } from "aws-lambda";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { marshall } from "@aws-sdk/util-dynamodb";

const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";

const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });
const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION_CODE,
});

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const { userSub, username, uploadedAvatarKey, dynamoUserId } = JSON.parse(record.body);

    try {
      // Delete DynamoDB record if exists
      if (dynamoUserId) {
        await client.send(
          new DeleteItemCommand({ TableName: USERS_TABLE, Key: marshall({ user_id: dynamoUserId }) })
        );
        console.log(`DynamoDB record deleted: ${dynamoUserId}`);
      }

      // Delete Cognito user if exists
      if (userSub) {
        await cognito.send(
          new AdminDeleteUserCommand({
            UserPoolId: process.env.EXPRESS_COGNITO_USER_POOL_ID!,
            Username: username,
          })
        );
        console.log(`Cognito user deleted: ${username}`);
      }

      // Delete S3 avatar if exists
      if (uploadedAvatarKey) {
        await s3Client.send(
          new DeleteObjectCommand({ Bucket: process.env.EXPRESS_S3_APP_BUCKET!, Key: uploadedAvatarKey })
        );
        console.log(`S3 avatar deleted: ${uploadedAvatarKey}`);
      }

      console.log("Cleanup job completed successfully for:", username);
    } catch (err) {
      console.error("Cleanup failed for:", username, err);
      // Re-throw to allow SQS retry if necessary
      throw err;
    }
  }
};