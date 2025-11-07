import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { AuthenticatedRequest } from "../middleware/auth";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const REFERRALS_TABLE = process.env.DYNAMODB_REFERRALS_TABLE || "Referrals";

/**
 * Generate a 6-character alphanumeric referral code
 */
const generateReferralCode = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

/**
 * Create a new referral
 * User can only have up to 5 referrals
 */
export const createReferral = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.user_id;

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  // Count existing referrals for this user
  const existingReferrals = await client.send(
    new QueryCommand({
      TableName: REFERRALS_TABLE,
      IndexName: "CreatedByIndex", // assumes a GSI on created_by
      KeyConditionExpression: "created_by = :userId",
      ExpressionAttributeValues: marshall({ ":userId": userId }),
    })
  );

  if ((existingReferrals.Items?.length || 0) >= 5) {
    return res.status(403).json({ error: "Referral limit reached (max 5)" });
  }

  const referralCode = generateReferralCode();

  const referralData = {
    referral_id: uuidv4(),
    created_by: userId,
    code: referralCode,
    created_at: new Date().toISOString(),
  };

  await client.send(
    new PutItemCommand({
      TableName: REFERRALS_TABLE,
      Item: marshall(referralData),
    })
  );

  res.status(201).json(referralData);
});

/**
 * Get all referrals for a specific user
 */
export const getUserReferrals = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.user_id

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  const response = await client.send(
    new QueryCommand({
      TableName: REFERRALS_TABLE,
      IndexName: "CreatedByIndex", // assumes a GSI on created_by
      KeyConditionExpression: "created_by = :userId",
      ExpressionAttributeValues: marshall({ ":userId": userId }),
    })
  );

  const referrals = (response.Items || []).map(item => unmarshall(item));

  res.status(200).json(referrals);
});

/**
 * Redeem a referral code
 */
export const redeemReferral = asyncHandler(async (req: Request, res: Response) => {
  const { code } = req.body;

  if (!code || code.length !== 6) {
    return res.status(400).json({ error: "Invalid referral code" });
  }

  // Check if the referral code exists
  const codeResponse = await client.send(
    new QueryCommand({
      TableName: REFERRALS_TABLE,
      IndexName: "ReferralCodeIndex",
      KeyConditionExpression: "code = :code",
      ExpressionAttributeValues: marshall({ ":code": code }),
      Limit: 1,
    })
  );

  if (!codeResponse.Items || codeResponse.Items.length === 0) {
    return res.status(404).json({ error: "Referral code not found" });
  }

  const referral = unmarshall(codeResponse.Items[0]);

  // Check if user already redeemed this referral
  if (referral.redeemed) {
    return res.status(403).json({ error: "Referral code has already been redeemed" });
  }

  const updatedReferral = {
    ...referral,
    redeemed: true,
    updated_at: new Date().toISOString(),
  }

  await client.send(
    new PutItemCommand({
      TableName: REFERRALS_TABLE,
      Item: marshall(updatedReferral),
    })
  );

  res.status(200).json(updatedReferral);
});


/**
 * Check a referral code (exists and not redeemed)
 */
export const checkReferral = asyncHandler(async (req: Request, res: Response) => {
  const { code } = req.query as { code?: string };

  if (!code || code.length !== 6) {
    return res.status(400).json({ error: "Invalid referral code" });
  }

  // Query referral by code
  const response = await client.send(
    new QueryCommand({
      TableName: REFERRALS_TABLE,
      IndexName: "ReferralCodeIndex", // assumes a GSI on `code`
      KeyConditionExpression: "code = :code",
      ExpressionAttributeValues: marshall({ ":code": code }),
      Limit: 1,
    })
  );

  if (!response.Items || response.Items.length === 0) {
    return res.status(404).json({ error: "NOT_FOUND" });
  }

  const referral = unmarshall(response.Items[0]);

  // If already redeemed, also return 404
  if (referral.redeemed) {
    return res.status(404).json({ error: "ALREADY_REDEEMED" });
  }

  res.status(200).json({
    code: referral.code,
    created_at: referral.created_at,
  });
});
