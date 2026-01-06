import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { AuthenticatedRequest } from "../middleware/auth";
import { Notification } from "../types";
import fetch from "node-fetch";
import { createNotification as create } from "../utils/helpers/notifications";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION_CODE,
});

const NOTIFICATIONS_TABLE =
  process.env.DYNAMODB_NOTIFICATIONS_TABLE || "Notifications";

/**
 * Create a notification
 */

export const createNotification = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const {
      user_id,
      actor_id,
      type,
      message,
      expo_push_token,
    } = req.body as {
      user_id: string; // target user to receive the notification
      actor_id: string;
      type: "projectViewed" | "newNote" | "newRating" | string;
      message: string;
      expo_push_token?: string;
    };

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    if (!type || !message) {
      return res.status(400).json({ error: "type and message are required" });
    }

    // Use the helper to create the notification
    const notification = await create(
      user_id,
      actor_id,
      type,
      message,
      expo_push_token
    );

    res.status(201).json({ message: "Notification created", notification });
  }
);

/**
 * Get all notifications for the authenticated user
 */
export const getNotifications = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const user_id = req.user?.user_id;

    if (!user_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const response = await client.send(
      new QueryCommand({
        TableName: NOTIFICATIONS_TABLE,
        KeyConditionExpression: "user_id = :uid",
        ExpressionAttributeValues: marshall({ ":uid": user_id }),
      })
    );

    const notifications = response.Items?.map((item) => unmarshall(item)) ?? [];

    res.status(200).json(notifications);
  }
);

/**
 * Mark a notification as read
 */
export const markNotificationRead = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const user_id = req.user?.user_id;
    const { id } = req.params;

    if (!user_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!id) {
      return res.status(400).json({ error: "Notification id is required" });
    }

    const now = new Date().toISOString();

    await client.send(
      new UpdateItemCommand({
        TableName: NOTIFICATIONS_TABLE,
        Key: marshall({ user_id, id }),
        UpdateExpression: "SET is_read = :read, updated_at = :updated",
        ExpressionAttributeValues: marshall({ ":read": true, ":updated": now }),
      })
    );

    res.status(200).json({ message: "Notification marked as read" });
  }
);

/**
 * Delete a notification
 */
export const deleteNotification = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const user_id = req.user?.user_id;
    const { id } = req.params;

    if (!user_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!id) {
      return res.status(400).json({ error: "Notification id is required" });
    }

    await client.send(
      new DeleteItemCommand({
        TableName: NOTIFICATIONS_TABLE,
        Key: marshall({ user_id, id }),
      })
    );

    res.status(200).json({ message: "Notification deleted" });
  }
);
