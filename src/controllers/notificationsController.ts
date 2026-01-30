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
import { v4 } from "uuid";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION_CODE,
});

const NOTIFICATIONS_TABLE =
  process.env.DYNAMODB_NOTIFICATIONS_TABLE || "Notifications";
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";
const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || "Projects";


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
      context
    } = req.body as {
      user_id: string; // target user to receive the notification
      actor_id: string;
      type: NotificationType;
      message: string;
      expo_push_token?: string;
      context: NotificationContext<any>
    };

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    if (!type || !message) {
      return res.status(400).json({ error: "type and message are required" });
    }

    // Use the generic metadata-driven helper
    const notification = await createNotificationItem({
      user_id,
      actor_id: actor_id ?? "",
      type,
      context,
      expo_push_token,
    });

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

export enum NotificationType {
  PROJECT_VIEWED = "projectViewed",
  NEW_NOTE = "newNote",
  NEW_RATING = "newRating",
  CUSTOM = "custom",
}

export type NotificationContextMap = {
  [NotificationType.PROJECT_VIEWED]: { projectId: string; projectName?: string; actorName?: string };
  [NotificationType.NEW_NOTE]: { projectId: string; imageName: string; actorName?: string };
  [NotificationType.NEW_RATING]: { projectId: string; imageName: string; rating?: number; actorName?: string };
  [NotificationType.CUSTOM]: { message: string };
};

export type NotificationContext<T extends NotificationType> = NotificationContextMap[T];

const NOTIFICATION_META: Record<
  NotificationType,
  {
    title: string;
    description?: (ctx?: any) => string;
  }
> = {
  [NotificationType.PROJECT_VIEWED]: {
    title: "Project viewed",
    description: (ctx) =>
      ctx?.actorName && ctx?.projectName
        ? `${ctx.actorName} viewed your project "${ctx.projectName}"`
        : "Your project was viewed",
  },
  [NotificationType.NEW_NOTE]: {
    title: "New note",
    description: (ctx) =>
      ctx?.actorName && ctx?.imageName
        ? `${ctx.actorName} added a new note to your project`
        : "A new note was added to your project",
  },
  [NotificationType.NEW_RATING]: {
    title: "New rating",
    description: (ctx) =>
      ctx?.actorName
        ? `${ctx.actorName} rated your project${ctx.rating ? ` ${ctx.rating}/5` : ""}`
        : `Your project was rated${ctx.rating ? ` ${ctx.rating}/5` : ""}`,
  },
  [NotificationType.CUSTOM]: {
    title: "Notification",
    description: (ctx) => ctx?.message ?? "You have a new notification",
  },
};
// ---------------------------- Helpers ----------------------------

export async function createNotificationItem<T extends NotificationType>({
  user_id,
  actor_id,
  type,
  context,
  expo_push_token,
}: {
  user_id: string;
  actor_id: string;
  type: T;
  context: NotificationContext<T>;
  expo_push_token?: string;
}) {
  const actorResponse = await client.send(
    new GetItemCommand({
      TableName: USERS_TABLE,
      Key: marshall({ user_id: actor_id }),
    })
  );

  if (!actorResponse.Item) {
    throw new Error("Actor not found")
  }

  const actor = unmarshall(actorResponse.Item)

  let projectResponse: any
  if ("projectId" in context) {
    projectResponse = await client.send(
      new GetItemCommand({
        TableName: PROJECTS_TABLE,
        Key: marshall({ project_id: context.projectId }),
      })
    )

    if (!projectResponse.Item) {
      throw new Error("Project not found")
    }
  }

  const project = unmarshall(projectResponse.Item)

  // Merge actor and project info into context for description
  const fullContext = {
    ...context,
    actorName: actor?.username,
    projectName: project?.name,
  };

  const meta = NOTIFICATION_META[type];

  const notification: Notification = {
    notification_id: v4(),
    user_id,
    actor_id,
    type,
    message: meta.description?.(fullContext) ?? "",
    link: project?.share_url ?? "",
    expo_uri: "",
    expo_push_token,
    is_read: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await client.send(
    new PutItemCommand({
      TableName: NOTIFICATIONS_TABLE,
      Item: marshall(notification),
    })
  );
  if (notification.expo_push_token) {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: notification.expo_push_token,
        sound: "default",
        title: notification.type,
        body: notification.message,
        data: { expo_uri: notification.expo_uri, link: notification.link, id: notification.notification_id },
      }),
    });
  }

  return notification
}
