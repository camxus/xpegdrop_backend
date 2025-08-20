import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { validationErrorHandler } from "../middleware/errorMiddleware";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { updateUserSchema } from "../utils/validation/userValidation";
import { UpdateUserInput, User } from "../types";
import { AuthenticatedRequest } from "../middleware/auth";
import { copyItemImage, getSignedImage, saveItemImage } from "../utils/s3";
import { lookup as mimeLookup, extension as mimeExtension } from "mime-types";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";

const TEMP_BUCKET = process.env.EXPRESS_S3_TEMP_BUCKET!;
const EXPRESS_S3_APP_BUCKET = process.env.EXPRESS_S3_APP_BUCKET!;


export const getUser = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.params.userId || req.user?.user_id;

      if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
      }

      const response = await client.send(
        new GetItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: userId }),
        })
      );

      if (!response.Item) {
        return res.status(404).json({ error: "User not found" });
      }

      const user = unmarshall(response.Item);

      // Get signed URL for avatar if it exists
      if (user.avatar && user.avatar.key) {
        user.avatar = await getSignedImage(s3Client, user.avatar.key);
      }

      // Remove sensitive information
      if (user.dropbox) {
        delete user.dropbox.access_token;
        delete user.dropbox.refresh_token;
      }

      res.status(200).json({ user });
    } catch (error: any) {
      console.error("Get user error:", error);
      res.status(500).json({ error: error.message || "Failed to fetch user" });
    }
  }
);

export const getCurrentUser = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.user_id;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const response = await client.send(
        new GetItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: userId }),
        })
      );

      if (!response.Item) {
        return res.status(404).json({ error: "User not found" });
      }

      const user = unmarshall(response.Item);

      // Get signed URL for avatar if it exists
      if (user.avatar && user.avatar.key) {
        user.avatar = await getSignedImage(s3Client, user.avatar.key);
      }

      res.status(200).json({ user });
    } catch (error: any) {
      console.error("Get current user error:", error);
      res.status(500).json({ error: error.message || "Failed to fetch user" });
    }
  }
);

export const updateUser = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { error, value } = updateUserSchema.validate(req.body);
    if (error) throw validationErrorHandler(error);

    const { first_name, last_name, bio, dropbox } =
      value as UpdateUserInput;

    let avatar = value.avatar
    const userId = req.user?.user_id;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    try {
      // Check if user exists
      const existingUserResponse = await client.send(
        new GetItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: userId }),
        })
      );

      if (!existingUserResponse.Item) {
        return res.status(404).json({ error: "User not found" });
      }

      const existingUser = unmarshall(existingUserResponse.Item);

      // Prepare update data
      const updateData: any = {
        updated_at: new Date().toISOString(),
      };

      if (first_name !== undefined) updateData.first_name = first_name;
      if (last_name !== undefined) updateData.last_name = last_name;
      if (bio !== undefined) updateData.bio = bio;
      if (dropbox !== undefined) updateData.dropbox = dropbox;

      // Handle avatar upload if provided
      const key = (ext: string) => `profile_images/${userId}.${ext}`;


      if (avatar) {
        const s3Client = new S3Client({ region: process.env._CODE });

        // Determine file extension
        const ext = avatar.key.split(".").pop();


        const destination = await copyItemImage(s3Client, { bucket: TEMP_BUCKET, key: avatar.key }, { bucket: EXPRESS_S3_APP_BUCKET, key: key(ext!) })

        // Delete temp file
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: TEMP_BUCKET,
            Key: avatar.key,
          })
        );

        avatar = destination
      }


      if (req.file) {
        const mimeType = req.file.mimetype; // e.g., image/png
        const ext = mimeExtension(mimeType); // e.g., 'png'

        if (!ext) {
          throw new Error("Unsupported avatar file type.");
        }


        avatar = await saveItemImage(s3Client, key(ext), req.file.buffer);
      }

      // Build update expression
      const updateExpressionParts: string[] = [];
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      Object.keys(updateData).forEach((key, index) => {
        const attributeName = `#attr${index}`;
        const attributeValue = `:val${index}`;

        updateExpressionParts.push(`${attributeName} = ${attributeValue}`);
        expressionAttributeNames[attributeName] = key;
        expressionAttributeValues[attributeValue] = updateData[key];
      });

      const updateExpression = `SET ${updateExpressionParts.join(", ")}`;

      await client.send(
        new UpdateItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: userId }),
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: marshall(expressionAttributeValues),
          ReturnValues: "ALL_NEW",
        })
      );

      // Fetch updated user
      const updatedUserResponse = await client.send(
        new GetItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: userId }),
        })
      );

      const updatedUser = unmarshall(updatedUserResponse.Item!);

      // Get signed URL for avatar if it exists
      if (updatedUser.avatar && updatedUser.avatar.key) {
        updatedUser.avatar = await getSignedImage(
          s3Client,
          updatedUser.avatar.key
        );
      }

      res.status(200).json({
        message: "User updated successfully",
        user: updatedUser,
      });
    } catch (error: any) {
      console.error("Update user error:", error);
      res.status(500).json({ error: error.message || "Failed to update user" });
    }
  }
);

export const deleteUser = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user?.user_id;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      // Check if user exists
      const existingUserResponse = await client.send(
        new GetItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: userId }),
        })
      );

      if (!existingUserResponse.Item) {
        return res.status(404).json({ error: "User not found" });
      }

      // Delete user from DynamoDB
      await client.send(
        new DeleteItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: userId }),
        })
      );

      res.status(200).json({
        message: "User deleted successfully",
      });
    } catch (error: any) {
      console.error("Delete user error:", error);
      res.status(500).json({ error: error.message || "Failed to delete user" });
    }
  }
);

export const getUserByUsername = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      const { username } = req.params;

      if (!username) {
        return res.status(400).json({ error: "Username is required" });
      }

      const response = await client.send(
        new ScanCommand({
          TableName: USERS_TABLE,
          FilterExpression: "username = :username",
          ExpressionAttributeValues: marshall({
            ":username": username,
          }),
        })
      );

      if (!response.Items || response.Items.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      const user = unmarshall(response.Items[0]);

      // Get signed URL for avatar if it exists
      if (user.avatar && user.avatar.key) {
        user.avatar = await getSignedImage(s3Client, user.avatar.key);
      }

      // Remove sensitive information for public access
      if (user.dropbox) {
        delete user.dropbox.access_token;
        delete user.dropbox.refresh_token;
      }
      delete user.email;

      res.status(200).json({ user });
    } catch (error: any) {
      console.error("Get user by username error:", error);
      res.status(500).json({ error: error.message || "Failed to fetch user" });
    }
  }
);
import { updateDropboxTokenSchema } from "../utils/validation/userValidation";

export const updateDropboxToken = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { error, value } = updateDropboxTokenSchema.validate(req.body);
    if (error) throw validationErrorHandler(error);

    try {
      const { dropbox } = value;
      const userId = req.user?.user_id;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      if (!dropbox?.access_token) {
        return res
          .status(400)
          .json({ error: "Dropbox access token is required" });
      }

      const updateData: any = {
        dropbox: dropbox,
        updated_at: new Date().toISOString(),
      };

      await client.send(
        new UpdateItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: userId }),
          UpdateExpression: "SET dropbox = :dropbox, updated_at = :updated",
          ExpressionAttributeValues: marshall({
            ":dropbox": dropbox,
            ":updated": updateData.updated_at,
          }),
        })
      );

      res.status(200).json({
        message: "Dropbox token updated successfully",
      });
    } catch (error: any) {
      console.error("Update Dropbox token error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to update Dropbox token" });
    }
  }
);
