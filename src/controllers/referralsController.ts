import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { v4 as uuidv4 } from "uuid";

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
export const createReferral = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.body;

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
export const getUserReferrals = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;

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
  const { code, userId } = req.body;

  if (!code || code.length !== 6) {
    return res.status(400).json({ error: "Invalid referral code" });
  }

  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
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

  // Prevent user from redeeming their own referral
  if (referral.created_by === userId) {
    return res.status(403).json({ error: "Cannot redeem your own referral code" });
  }

  // Check if user already redeemed this referral
  if (referral.redeemed_by?.includes(userId)) {
    return res.status(403).json({ error: "Referral code already redeemed by this user" });
  }

  // Add user to redeemed list
  const updatedRedeemedBy = [...(referral.redeemed_by || []), userId];

  await client.send(
    new PutItemCommand({
      TableName: REFERRALS_TABLE,
      Item: marshall({
        ...referral,
        redeemed_by: updatedRedeemedBy,
        updated_at: new Date().toISOString(),
      }),
    })
  );

  res.status(200).json({
    message: "Referral code redeemed successfully",
    referral: { ...referral, redeemed_by: updatedRedeemedBy },
  });
});
