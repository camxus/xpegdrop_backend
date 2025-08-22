import { SQSHandler } from "aws-lambda";
import crypto from "crypto";
import {
  SignUpCommand,
  AdminConfirmSignUpCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { copyItemImage } from "../../../utils/s3";

const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });
const sqsClient = new SQSClient({ region: process.env.AWS_REGION_CODE });
const SIGNUP_CLEANUP_QUEUE = "signup-cleanup-queue"

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION_CODE,
});


const enqueueCleanup = async (payload: any) => {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: `https://sqs.${process.env.AWS_REGION_CODE}.amazonaws.com/${process.env.AWS_ACCOUNT_ID}/${SIGNUP_CLEANUP_QUEUE}`,
      MessageBody: JSON.stringify(payload),
    })
  );
};

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const data = JSON.parse(record.body);
    const { password, email, username, first_name, last_name, bio, dropbox, avatar } = data;

    let createdUserSub: string | null = null;
    let uploadedAvatarKey: string | null = null;
    let userData: any = null;

    try {
      // Cognito signup
      const response = await cognito.send(
        new SignUpCommand({
          ClientId: process.env.EXPRESS_COGNITO_CLIENT_ID!,
          SecretHash: crypto
            .createHmac("SHA256", process.env.EXPRESS_COGNITO_SECRET!)
            .update(username + process.env.EXPRESS_COGNITO_CLIENT_ID!)
            .digest("base64"),
          Username: username,
          Password: password,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "given_name", Value: first_name },
            { Name: "family_name", Value: last_name },
          ],
        })
      );

      // Auto-confirm in dev
      if (process.env.NODE_ENV === "development") {
        await cognito.send(
          new AdminConfirmSignUpCommand({
            UserPoolId: process.env.EXPRESS_COGNITO_USER_POOL_ID!,
            Username: username,
          })
        );
      }

      createdUserSub = response.UserSub!;
      const key = (ext: string) => `profile_images/${createdUserSub}.${ext}`;

      // Handle avatar
      if (avatar) {
        const ext = avatar.key.split(".").pop()!;
        const destination = await copyItemImage(
          s3Client,
          { bucket: avatar.bucket, key: avatar.key },
          { bucket: process.env.EXPRESS_S3_APP_BUCKET!, key: key(ext) }
        );

        await s3Client.send(
          new DeleteObjectCommand({ Bucket: process.env.EXPRESS_S3_TEMP_BUCKET!, Key: avatar.key })
        );

        uploadedAvatarKey = destination.key;
      }

      // Save user in DynamoDB
      userData = {
        user_id: createdUserSub,
        username,
        email,
        first_name,
        last_name,
        bio: bio || null,
        avatar,
        dropbox,
        created_at: new Date().toISOString(),
      };

      await client.send(new PutItemCommand({ TableName: USERS_TABLE, Item: marshall(userData) }));
      console.log("User created successfully:", username);
    } catch (err) {
      console.error("Signup worker failed, enqueueing cleanup:", err);

      // Send cleanup job to SQS
      await enqueueCleanup({
        userSub: createdUserSub,
        username,
        uploadedAvatarKey,
        dynamoUserId: userData?.user_id,
      });

      // Optionally re-throw to let SQS retry signup if needed
      throw err;
    }
  }
};
