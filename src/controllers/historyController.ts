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
import { v4 } from "uuid";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION_CODE,
});

const PROJECTS_HISTORY_TABLE =
  process.env.DYNAMODB_PROJECTS_HISTORY_TABLE || "ProjectsHistory";

/**
 * Create a project history record
 */
export const createProjectHistory = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const {
      project_id,
      user_id,
      actor_id,
      type,
      title,
      description,
    } = req.body as {
      project_id: string;
      user_id: string;
      actor_id: string;
      type: string;
      title: string;
      description?: string;
    };

    if (!project_id || !user_id || !actor_id || !type || !title) {
      return res.status(400).json({
        error: "project_id, user_id, actor_id, type, and title are required",
      });
    }

    const record = {
      project_history_id: v4(),
      project_id,
      user_id,
      actor_id,
      type,
      title,
      description: description || "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await client.send(
      new PutItemCommand({
        TableName: PROJECTS_HISTORY_TABLE,
        Item: marshall(record),
      })
    );

    res.status(201).json({ message: "Project history created", record });
  }
);

/**
 * Get all history for a project
 */
export const getProjectHistory = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { project_id } = req.params;

    if (!project_id) {
      return res.status(400).json({ error: "project_id is required" });
    }

    const response = await client.send(
      new QueryCommand({
        TableName: PROJECTS_HISTORY_TABLE,
        KeyConditionExpression: "project_id = :pid",
        ExpressionAttributeValues: marshall({ ":pid": project_id }),
        ScanIndexForward: true, // chronological order
      })
    );

    const history = response.Items?.map((item) => unmarshall(item)) ?? [];

    res.status(200).json(history);
  }
);

/**
 * Update a project history record
 */
export const updateProjectHistory = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { project_id, id } = req.params;
    const { title, description, type } = req.body;

    if (!project_id || !id) {
      return res.status(400).json({ error: "project_id and id are required" });
    }

    const updates: Record<string, any> = {};
    const expressionParts: string[] = [];
    const attributeValues: Record<string, any> = {};

    if (title) {
      expressionParts.push("title = :title");
      attributeValues[":title"] = title;
    }
    if (description) {
      expressionParts.push("description = :desc");
      attributeValues[":desc"] = description;
    }
    if (type) {
      expressionParts.push("type = :type");
      attributeValues[":type"] = type;
    }

    if (expressionParts.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    attributeValues[":updated"] = new Date().toISOString();
    expressionParts.push("updated_at = :updated");

    await client.send(
      new UpdateItemCommand({
        TableName: PROJECTS_HISTORY_TABLE,
        Key: marshall({ project_id, id }),
        UpdateExpression: `SET ${expressionParts.join(", ")}`,
        ExpressionAttributeValues: marshall(attributeValues),
      })
    );

    res.status(200).json({ message: "Project history updated" });
  }
);

/**
 * Delete a project history record
 */
export const deleteProjectHistory = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { project_id, id } = req.params;

    if (!project_id || !id) {
      return res.status(400).json({ error: "project_id and id are required" });
    }

    await client.send(
      new DeleteItemCommand({
        TableName: PROJECTS_HISTORY_TABLE,
        Key: marshall({ project_id, id }),
      })
    );

    res.status(200).json({ message: "Project history deleted" });
  }
);
