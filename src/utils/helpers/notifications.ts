import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { Notification, Project, User } from "../../types";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { v4 } from "uuid";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const NOTIFICATIONS_TABLE = process.env.DYNAMODB_NOTIFICATIONS_TABLE || "Notifications";
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";
const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || "Projects";

/**
 * Send push notification via Expo
 */
async function sendExpoPushNotification(expoPushToken: string, notification: Notification) {
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: expoPushToken,
        sound: "default",
        title: notification.type,
        body: notification.message,
        data: { expo_uri: notification.expo_uri, link: notification.link, id: notification.notification_id },
      }),
    });
  } catch (err) {
    console.error("Failed to send Expo push notification:", err);
  }
}

/**
 * Fetch user by ID from DynamoDB
 */
async function getProjectById(project_id: string) {
  const response = await client.send(
    new GetItemCommand({
      TableName: PROJECTS_TABLE,
      Key: marshall({ project_id }),
    })
  );
  if (!response.Item) return null;
  return unmarshall(response.Item) as Project;
}

/**
 * Fetch user by ID from DynamoDB
 */
async function getUserById(user_id: string) {
  const response = await client.send(
    new GetItemCommand({
      TableName: USERS_TABLE,
      Key: marshall({ user_id }),
    })
  );
  if (!response.Item) return null;
  return unmarshall(response.Item) as User;
}

/**
 * Low-level function to store notification in DynamoDB and optionally send push
 */
async function storeNotification(notification: Notification) {
  await client.send(
    new PutItemCommand({
      TableName: NOTIFICATIONS_TABLE,
      Item: marshall(notification),
    })
  );

  if (notification.expo_push_token) {
    await sendExpoPushNotification(notification.expo_push_token, notification);
  }

  return notification;
}

/**
 * Type-specific notification creators
 */

export async function projectViewedByUser(
  ownerUserId: string,
  actorId: string,
  projectId: string,
  expo_push_token?: string
) {
  const actor = await getUserById(actorId);
  const project = await getProjectById(projectId);
  const actorUsername = actor?.username || "Someone";

  const message = `${actorUsername} added a new note to your project.`;
  const link = project?.share_url;
  const expo_uri = ``;

  const notification: Notification = {
    notification_id: v4(),
    user_id: ownerUserId,
    actor_id: actorId,
    type: "projectViewed",
    message,
    link,
    expo_uri,
    expo_push_token,
    is_read: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  return storeNotification(notification);
}

export async function newNote(
  projectOwnerId: string,
  actorId: string,
  projectId: string,
  imageName: string,
  expo_push_token?: string
) {
  const actor = await getUserById(actorId);
  const project = await getProjectById(projectId);
  const actorUsername = actor?.username || "Someone";

  const message = `${actorUsername} added a new note to your project.`;
  const link = project?.share_url + `?imageName=${imageName}`;
  const expo_uri = ``;

  const notification: Notification = {
    notification_id: v4(),
    user_id: projectOwnerId,
    actor_id: actorId,
    type: "newNote",
    message,
    link,
    expo_uri,
    expo_push_token,
    is_read: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  return storeNotification(notification);
}

export async function newRating(
  projectOwnerId: string,
  actorId: string,
  projectId: string,
  imageName: string,
  expo_push_token?: string
) {
  const actor = await getUserById(actorId);
  const project = await getProjectById(projectId);
  const actorUsername = actor?.username || "Someone";

  const message = `${actorUsername} rated your project.`;
  const link = project?.share_url + `?imageName=${imageName}`;
  const expo_uri = ``;

  const notification: Notification = {
    notification_id: v4(),
    user_id: projectOwnerId,
    actor_id: actorId,
    type: "newRating",
    message,
    link,
    expo_uri,
    expo_push_token,
    is_read: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  return storeNotification(notification);
}

/**
 * Dispatcher: creates appropriate notification based on type
 */
export async function createNotification(
  user_id: string,                         // recipient
  actorId: string,                        // user performing the action
  type: "projectViewed" | "newNote" | "newRating" | string,
  expo_push_token?: string,
  projectId?: string,
  imageName?: string
) {
  switch (type) {
    case "projectViewed":
      if (projectId) return projectViewedByUser(user_id, actorId, projectId, expo_push_token);
    case "newNote":
      if (projectId && imageName) return newNote(user_id, actorId, projectId, imageName, expo_push_token);
    case "newRating":
      if (projectId && imageName) return newRating(user_id, actorId, projectId, imageName, expo_push_token);
    default:
      throw new Error(`Unsupported notification type: ${type}`);
  }
}
