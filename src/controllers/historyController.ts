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
import { ProjectHistoryType } from "../types";

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
      type,
      title,
      context
    } = req.body as {
      project_id: string;
      type: ProjectHistoryType;
      title: string;
      description?: string;
      context: ProjectHistoryContext<any>
    };

    if (!project_id || !type || !title) {
      return res.status(400).json({
        error: "project_id, type, and title are required",
      });
    }

    const record = await createProjectHistoryItem({
      project_id,
      actor_id: req.user?.user_id,
      type,
      context
    });

    res.status(201).json({ record });
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
    const { project_id, project_history_id } = req.params;
    const { title, description, type } = req.body;

    if (!project_id || !project_history_id) {
      return res.status(400).json({ error: "project_id and project_history_id are required" });
    }

    const updates: string[] = [];
    const values: Record<string, any> = {};

    if (title) {
      updates.push("title = :title");
      values[":title"] = title;
    }

    if (description) {
      updates.push("description = :description");
      values[":description"] = description;
    }

    if (type) {
      updates.push("type = :type");
      values[":type"] = type;
    }

    if (!updates.length) {
      throw new Error("No fields to update");
    }

    updates.push("updated_at = :updated_at");
    values[":updated_at"] = new Date().toISOString();

    await client.send(
      new UpdateItemCommand({
        TableName: PROJECTS_HISTORY_TABLE,
        Key: marshall({ project_id, project_history_id }),
        UpdateExpression: `SET ${updates.join(", ")}`,
        ExpressionAttributeValues: marshall(values),
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


// helpers
export const isProjectHistoryType = (
  value: string
): value is ProjectHistoryType =>
  Object.values(ProjectHistoryType).includes(value as ProjectHistoryType);

const HISTORY_META: Record<
  ProjectHistoryType,
  {
    title: string;
    description?: (ctx?: any) => string;
  }
> = {
  [ProjectHistoryType.PROJECT_INITIATED]: {
    title: "Project added",
  },
  [ProjectHistoryType.PROJECT_CREATED]: {
    title: "Project created",
  },
  [ProjectHistoryType.PROJECT_UPDATED]: {
    title: "Project updated",
  },
  [ProjectHistoryType.PROJECT_DELETED]: {
    title: "Project deleted",
  },
  [ProjectHistoryType.FILES_ADDED]: {
    title: "Files added",
    description: (ctx) => {
      if (!ctx?.fileNames || !ctx.fileNames.length) return "Files added";

      const count = ctx.fileNames.length;

      if (count === 1) return `File "${ctx.fileNames[0]}" was added`;
      if (count === 2) return `Files "${ctx.fileNames.join('" and "')}" were added`;

      // More than 2 files
      return `Files "${ctx.fileNames.slice(0, 2).join('", "')}" and ${count - 2} more were added`;
    },
  },
  [ProjectHistoryType.FILE_REMOVED]: {
    title: "File removed",
    description: (ctx) =>
      ctx?.fileName ? `File "${ctx.fileName}" was removed` : "File removed",
  },
  [ProjectHistoryType.NOTE]: {
    title: "Note",
  },
  [ProjectHistoryType.RATING]: {
    title: "Rating added",
    description: (ctx) =>
      ctx?.rating ? `Rated ${ctx.rating}/5` : "Rating added",
  },
};

export type ProjectHistoryContextMap = {
  [ProjectHistoryType.PROJECT_INITIATED]: undefined;

  [ProjectHistoryType.PROJECT_CREATED]: undefined;

  [ProjectHistoryType.PROJECT_UPDATED]: {
    fields?: string[]; // ["title", "description"]
  };

  [ProjectHistoryType.PROJECT_DELETED]: undefined;

  [ProjectHistoryType.FILES_ADDED]: {
    fileNames: string[];
  };

  [ProjectHistoryType.FILE_REMOVED]: {
    fileName: string;
  };

  [ProjectHistoryType.NOTE]: {
    noteId?: string;
  };

  [ProjectHistoryType.RATING]: {
    rating: number; // 1–5
  };
};

export type ProjectHistoryContext<
  T extends ProjectHistoryType
> = ProjectHistoryContextMap[T];

type CreateHistoryParams<T extends ProjectHistoryType> = {
  project_id: string;
  actor_id?: string;
  type: T;
  description?: string;
  context?: ProjectHistoryContext<T>;
};

export const createProjectHistoryItem = async <
  T extends ProjectHistoryType
>({
  project_id,
  actor_id,
  type,
  description,
  context,
}: CreateHistoryParams<T>) => {
  const meta = HISTORY_META[type];

  const now = new Date().toISOString();

  const item = {
    project_id,
    project_history_id: v4(),
    actor_id,
    type,
    title: meta.title,
    description: description ?? meta.description?.(context) ?? "",
    created_at: now,
    updated_at: now,
  };

  await client.send(
    new PutItemCommand({
      TableName: PROJECTS_HISTORY_TABLE,
      Item: marshall(item),
    })
  );

  return item;
};
