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
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { v4 as uuidv4, v4 } from "uuid";
import { Request, Response } from "express";
import { authenticate, AuthenticatedRequest, getUserFromToken } from "../middleware/auth";
import { User } from "../types";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const RATINGS_TABLE = process.env.DYNAMODB_RATINGS_TABLE || "Ratings";

export class Rating {
  rating_id?: string = undefined;
  project_id: string = "";
  user_id: string = "";
  image_name: string = "";
  value: number = 0;
  author = { first_name: "", last_name: "" }
}

// CREATE Rating
export const createRating = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { project_id, image_name, value, author } = req.body;

    if (!project_id || !image_name || value === undefined) {
      return res.status(400).json({ error: "project_id, image_name and value are required" });
    }

    const authHeader = req.headers.authorization;
    if (authHeader) await getUserFromToken(authHeader.substring(7)).then((user) => req.user = user)

    const rating: Rating = {
      rating_id: uuidv4(),
      project_id,
      image_name,
      user_id: req.user?.user_id || `anonymous-${uuidv4()}`, // mark as anonymous if no user
      value,
      author: req.user ? { first_name: req.user?.first_name, last_name: req?.user?.last_name } : author
    };

    try {
      await client.send(
        new PutItemCommand({
          TableName: RATINGS_TABLE,
          Item: marshall(rating),
        })
      );

      res.status(201).json(rating);
    } catch (error: any) {
      console.error("Create rating error:", error);
      res.status(500).json({ error: error.message || "Failed to create rating" });
    }
  }
);

// GET Ratings by projectId
export const getRatings = asyncHandler(
  async (req: Request, res: Response) => {
    const { projectId } = req.params;

    if (!projectId) {
      return res.status(400).json({ error: "projectId is required" });
    }

    try {
      const response = await client.send(
        new ScanCommand({
          TableName: RATINGS_TABLE,
          FilterExpression: "project_id = :projectId",
          ExpressionAttributeValues: marshall({
            ":projectId": projectId,
          }),
        })
      );

      const ratings = response.Items?.map((item) => unmarshall(item)) || [];
      res.status(200).json({ ratings, total: ratings.length });
    } catch (error: any) {
      console.error("Get ratings error:", error);
      res.status(500).json({ error: error.message || "Failed to fetch ratings" });
    }
  }
);

// UPDATE Rating
export const updateRating = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { ratingId } = req.params;
    const { value } = req.body;
    const authHeader = req.headers.authorization;

    if (authHeader)
      await getUserFromToken(authHeader.substring(7)).then((user) => req.user = user)

    if (!ratingId || value === undefined) {
      return res.status(400).json({ error: "ratingId and value are required" });
    }

    try {
      const getRes = await client.send(
        new GetItemCommand({
          TableName: RATINGS_TABLE,
          Key: marshall({ rating_id: ratingId }),
        })
      );


      if (!getRes.Item) {
        return res.status(404).json({ error: "Rating not found" });
      }

      const rating = unmarshall(getRes.Item) as unknown as Rating

      if (!rating.user_id.includes("anonymous")) {
        if (req.user?.user_id !== rating.user_id) {
          return res.status(400).json({ error: "user_id mismatch" });
        }
      }

      await client.send(
        new UpdateItemCommand({
          TableName: RATINGS_TABLE,
          Key: marshall({ rating_id: ratingId }),
          UpdateExpression: "SET #v = :value",
          ExpressionAttributeNames: { "#v": "value" },
          ExpressionAttributeValues: marshall({ ":value": value }),
        })
      );

      res.status(200).json({ message: "Rating updated successfully" });
    } catch (error: any) {
      console.error("Update rating error:", error);
      res.status(500).json({ error: error.message || "Failed to update rating" });
    }
  }
);

// DELETE Rating
export const deleteRating = asyncHandler(
  async (req: Request, res: Response) => {
    const { ratingId } = req.params;

    if (!ratingId) {
      return res.status(400).json({ error: "ratingId is required" });
    }

    try {
      await client.send(
        new DeleteItemCommand({
          TableName: RATINGS_TABLE,
          Key: marshall({ rating_id: ratingId }),
        })
      );

      res.status(200).json({ message: "Rating deleted successfully" });
    } catch (error: any) {
      console.error("Delete rating error:", error);
      res.status(500).json({ error: error.message || "Failed to delete rating" });
    }
  }
);
