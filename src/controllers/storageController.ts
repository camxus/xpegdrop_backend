import { Response } from "express";

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { asyncHandler } from "../middleware/asyncHandler";
import { AuthenticatedRequest } from "../middleware/auth";
import { BackblazeService } from "../utils/backblaze";

const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";
const B2_BUCKET_ID = process.env.EXPRESS_B2_BUCKET_ID!;

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });

export const getStorageStats = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.query.tenantId as string | undefined

  try {
    if (!req.user?.user_id) {
      return res.status(400).json({ error: "User not authenticated" });
    }

    // Fetch user from DynamoDB
    const userResp = await dynamoClient.send(
      new GetItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id: req.user.user_id }),
      })
    );

    if (!userResp.Item) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = unmarshall(userResp.Item) as any;

    // Determine allocated space based on membership
    let allocated = Infinity;
    if (user.membership?.membership_id === "pro") allocated = 500 * 1024 ** 3; // 500GB


    // Initialize Backblaze service
    const b2Service = new BackblazeService(B2_BUCKET_ID, req.user?.user_id, tenantId);

    // Get storage usage
    const storageInfo = await b2Service.getStorageSpaceUsage(allocated);

    return res.json({ storage: storageInfo });
  } catch (error: any) {
    console.error("Failed to fetch B2 storage stats:", error);
    return res.status(500).json({ error: "Failed to fetch storage stats" });
  }
});
