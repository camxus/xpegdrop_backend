import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { AuthenticatedRequest } from "../middleware/auth";
import { EXIFData } from "../types";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION_CODE,
});

const METADATA_TABLE =
  process.env.DYNAMODB_IMAGE_METADATA_TABLE || "Metadata";

/**
 * Create metadata for a single image
 */
export const createImageMetadata = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { project_id, image_name, exif_data, image_hash } = req.body as {
      project_id: string;
      image_name: string;
      exif_data: EXIFData;
      image_hash?: string;
    };

    if (!project_id || !image_name || !exif_data) {
      return res.status(400).json({
        error: "project_id, image_name and exif_data are required",
      });
    }

    const now = new Date().toISOString();

    await client.send(
      new PutItemCommand({
        TableName: METADATA_TABLE,
        Item: marshall({
          project_id,
          image_name,
          exif_data,
          image_hash,
          created_at: now,
          updated_at: now,
        }),
        ConditionExpression:
          "attribute_not_exists(project_id) AND attribute_not_exists(image_name)",
      })
    );

    res.status(201).json({
      message: "Image metadata created",
    });
  }
);

/**
 * Batch create metadata for a project (upload flow)
 */
export const batchCreateImageMetadata = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { project_id, file_metadata } = req.body as {
      project_id: string;
      file_metadata: Record<string, EXIFData>;
    };

    if (!project_id || !file_metadata) {
      return res.status(400).json({
        error: "project_id and file_metadata are required",
      });
    }

    const now = new Date().toISOString();

    const requests = Object.entries(file_metadata).map(
      ([image_name, exif_data]) => ({
        PutRequest: {
          Item: marshall({
            project_id,
            image_name,
            exif_data,
            created_at: now,
            updated_at: now,
          }),
        },
      })
    );

    // DynamoDB batch limit = 25 items
    for (let i = 0; i < requests.length; i += 25) {
      await client.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [METADATA_TABLE]: requests.slice(i, i + 25),
          },
        })
      );
    }

    res.status(201).json({
      message: "Image metadata batch created",
      count: requests.length,
    });
  }
);

/**
 * Get metadata for a single image
 */
export const getImageMetadata = asyncHandler(
  async (req: Request, res: Response) => {
    const { project_id, image_name } = req.params;

    if (!project_id || !image_name) {
      return res.status(400).json({
        error: "project_id and image_name are required",
      });
    }

    const response = await client.send(
      new GetItemCommand({
        TableName: METADATA_TABLE,
        Key: marshall({ project_id, image_name }),
      })
    );

    if (!response.Item) {
      return res.status(404).json({
        error: "Metadata not found",
      });
    }

    res.status(200).json(unmarshall(response.Item));
  }
);

/**
 * Get all metadata for a project
 */
export const getProjectMetadata = asyncHandler(
  async (req: Request, res: Response) => {
    const { project_id } = req.params;

    if (!project_id) {
      return res.status(400).json({
        error: "project_id is required",
      });
    }

    const response = await client.send(
      new QueryCommand({
        TableName: METADATA_TABLE,
        KeyConditionExpression: "project_id = :pid",
        ExpressionAttributeValues: marshall({
          ":pid": project_id,
        }),
      })
    );

    const items =
      response.Items?.map((item) => unmarshall(item)) ?? [];

    res.status(200).json(items);
  }
);

/**
 * Delete metadata for a single image
 */
export const deleteImageMetadata = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { project_id, image_name } = req.params;

    if (!project_id || !image_name) {
      return res.status(400).json({
        error: "project_id and image_name are required",
      });
    }

    await client.send(
      new DeleteItemCommand({
        TableName: METADATA_TABLE,
        Key: marshall({ project_id, image_name }),
      })
    );

    res.status(200).json({
      message: "Image metadata deleted",
    });
  }
);