import { Request, Response } from "express";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { AuthenticatedRequest } from "../middleware/auth";
import { GetItemCommand, PutItemCommand, UpdateItemCommand, DeleteItemCommand, QueryCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { asyncHandler } from "../middleware/asyncHandler";
import { Project, Share } from "../types";

const SHARES_TABLE = process.env.DYNAMODB_SHARES_TABLE || "Shares";
const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });

/* =========================
   1️⃣ Create a Share (with ownership / tenant admin check)
========================= */
export const createShare = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { project_id, name, mode, approved_users, approved_emails, is_public, can_download, expires_at } = req.body;

    if (!["collaborative", "presentation"].includes(mode)) {
      return res.status(400).json({ error: "INVALID_MODE" });
    }

    if (!req.user) return res.status(401).json({ error: "UNAUTHORIZED" });

    // Fetch the project (assuming you have a projects table / service)
    const projectResult = await client.send(
      new GetItemCommand({
        TableName: process.env.DYNAMODB_PROJECTS_TABLE!,
        Key: marshall({ project_id }),
      })
    );

    if (!projectResult.Item) return res.status(404).json({ error: "PROJECT_NOT_FOUND" });

    const project = unmarshall(projectResult.Item) as Project; // type as your Project type

    const isOwner = project.user_id === req.user.user_id;
    let isTenantAdmin = false;

    if (project.tenant_id && project.approved_tenant_users) {
      isTenantAdmin = project.approved_tenant_users.some(
        (u) => u.user_id === req.user?.user_id && u.role === "admin"
      );
    }

    if (!isOwner && !isTenantAdmin) {
      return res.status(403).json({ error: "ONLY_OWNER_OR_TENANT_ADMIN_CAN_SHARE" });
    }

    const share: Share = {
      share_id: crypto.randomUUID(),
      project_id,
      user_id: req.user.user_id,
      name,
      mode,
      approved_users: approved_users || [],
      approved_emails: approved_emails || [],
      is_public: !!is_public,
      can_download: !!can_download,
      expires_at: expires_at ? new Date(expires_at).toISOString() : undefined,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await client.send(
      new PutItemCommand({
        TableName: SHARES_TABLE,
        Item: marshall(share),
      })
    );

    res.status(201).json(share);
  } catch (error: any) {
    console.error("Create share error:", error);
    res.status(500).json({ error: error.message || "Failed to create share" });
  }
});

/* =========================
   2️⃣ Get a Share by ID + Mode
========================= */
export const getShareById = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { shareId, mode } = req.params;

    if (!["s", "p"].includes(mode)) {
      return res.status(400).json({ error: "INVALID_SHARE_TYPE" });
    }

    const m = mode === "s" ? "collaborative" : "presentation";

    const result = await client.send(
      new GetItemCommand({
        TableName: SHARES_TABLE,
        Key: marshall({ share_id: shareId, mode: m }),
      })
    );

    if (!result.Item) return res.status(404).json({ error: "SHARE_NOT_FOUND" });

    const share = unmarshall(result.Item) as Share;

    res.status(200).json(share);
  } catch (error: any) {
    console.error("Get share by ID error:", error);
    res.status(500).json({ error: error.message || "Failed to fetch share" });
  }
});

/* =========================
   3️⃣ Update a Share
========================= */
export const updateShare = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { shareId } = req.params;
    const updates = req.body;

    const result = await client.send(
      new GetItemCommand({
        TableName: SHARES_TABLE,
        Key: marshall({ share_id: shareId }),
      })
    );

    if (!result.Item) return res.status(404).json({ error: "Share not found" });

    const updateExpression: string[] = [];
    const expressionValues: Record<string, any> = {};

    for (const key in updates) {
      if (updates[key] !== undefined) {
        updateExpression.push(`${key} = :${key}`);
        expressionValues[`:${key}`] = updates[key];
      }
    }

    updateExpression.push("updated_at = :updated_at");
    expressionValues[":updated_at"] = new Date().toISOString();

    await client.send(
      new UpdateItemCommand({
        TableName: SHARES_TABLE,
        Key: marshall({ share_id: shareId }),
        UpdateExpression: `SET ${updateExpression.join(", ")}`,
        ExpressionAttributeValues: marshall(expressionValues),
        ReturnValues: "ALL_NEW",
      })
    );

    res.status(200).json({ message: "Share updated" });
  } catch (error: any) {
    console.error("Update share error:", error);
    res.status(500).json({ error: error.message || "Failed to update share" });
  }
});

/* =========================
   4️⃣ Delete a Share
========================= */
export const deleteShare = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { shareId } = req.params;

    const result = await client.send(
      new GetItemCommand({
        TableName: SHARES_TABLE,
        Key: marshall({ share_id: shareId }),
      })
    );

    if (!result.Item) return res.status(404).json({ error: "SHARE_NOT_FOUND" });

    const share = unmarshall(result.Item) as Share;

    if (req.user?.user_id !== share.user_id) {
      return res.status(403).json({ error: "ONLY_OWNER_CAN_DELETE" });
    }

    await client.send(
      new DeleteItemCommand({
        TableName: SHARES_TABLE,
        Key: marshall({ share_id: shareId }),
      })
    );

    res.status(200).json({ message: "Share deleted" });
  } catch (error: any) {
    console.error("Delete share error:", error);
    res.status(500).json({ error: error.message || "Failed to delete share" });
  }
});

/* =========================
   5️⃣ List all Shares for a Project
========================= */
export const listSharesByProject = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { projectId } = req.params;

    const result = await client.send(
      new QueryCommand({
        TableName: SHARES_TABLE,
        IndexName: "ProjectIdIndex", // GSI on project_id
        KeyConditionExpression: "project_id = :projectId",
        ExpressionAttributeValues: marshall({ ":projectId": projectId }),
      })
    );

    const shares = result.Items?.map(item => unmarshall(item) as Share) || [];
    res.status(200).json(shares);
  } catch (error: any) {
    console.error("List shares by project error:", error);
    res.status(500).json({ error: error.message || "Failed to list shares" });
  }
});
