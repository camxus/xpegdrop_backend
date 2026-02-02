import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { DynamoDBClient, UpdateItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { AuthenticatedRequest } from "../middleware/auth";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";

const GOOGLE_CLIENT_ID = process.env.EXPRESS_GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.EXPRESS_GOOGLE_CLIENT_SECRET!;
const REDIRECT_URI = `${process.env.EXPRESS_PUBLIC_BACKEND_URL}/api/google/callback`;

const STATE_SECRET = process.env.EXPRESS_JWT_SECRET!

// -----------------------------
// Step 1: Generate Google Auth URL
// -----------------------------
export const getGoogleAuthUrl = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const state = jwt.sign({ ts: Date.now(), user_id: req.user?.user_id }, STATE_SECRET, { expiresIn: "10m" });


  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile https://www.googleapis.com/auth/drive.readonly");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");

  res.json({ url: url.toString() });
});

// -----------------------------
// Step 2: Handle Google OAuth callback
// -----------------------------
export const handleGoogleCallback = asyncHandler(async (req: Request, res: Response) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).send("Missing code or state");
  }
  try {
    const payload = jwt.verify(state as string, STATE_SECRET) as any;
    console.log("Valid state from user:", payload.user_id);
  } catch (err) {
    return res.status(400).send("Invalid or expired state");
  }

  try {
    // Exchange code for tokens
    const tokenRes = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        code: code as string,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token, refresh_token } = tokenRes.data;

    // Get user info
    const userInfoRes = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const userInfo = userInfoRes.data;

    // Redirect to frontend with tokens
    const frontendUrl = new URL(process.env.EXPRESS_PUBLIC_FRONTEND_URL!);
    frontendUrl.searchParams.set("google_access_token", access_token);
    frontendUrl.searchParams.set("google_refresh_token", refresh_token);
    frontendUrl.searchParams.set("google_user_email", userInfo.email);

    res.redirect(frontendUrl.toString());
  } catch (err: any) {
    console.error("Google token exchange failed:", err.response?.data || err.message);
    res.status(500).send("Failed to exchange code for tokens");
  }
});

// -----------------------------
// Step 3: Callback with storing tokens in DynamoDB
// -----------------------------
export const handleGoogleCallbackWithUpdateUser = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).json({ error: "Missing code or state" });
  }

  try {
    const payload = jwt.verify(state as string, STATE_SECRET) as any;
    console.log("Valid state from user:", payload.user_id);
  } catch (err) {
    return res.status(400).send("Invalid or expired state");
  }

  if (!req.user?.user_id) {
    return res.status(400).json({ error: "Missing user_id to link Google" });
  }

  try {
    // Exchange code for tokens
    const tokenRes = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        code: code as string,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token, refresh_token } = tokenRes.data;

    // Store in DynamoDB
    await client.send(
      new UpdateItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id: req.user.user_id }),
        UpdateExpression: "SET google = :google",
        ExpressionAttributeValues: marshall({
          ":google": { access_token, refresh_token },
        }),
      })
    );

    res.redirect(`${process.env.EXPRESS_PUBLIC_FRONTEND_URL}/`);
  } catch (err: any) {
    console.error("Google token exchange failed:", err.response?.data || err.message);
    res.status(500).json({ error: "Google authentication failed" });
  }
});

// -----------------------------
// Step 4: Get Google Drive stats
// -----------------------------
export const getGoogleStats = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user?.google?.access_token) {
    return res.status(400).json({ error: "Google not linked" });
  }

  try {
    const driveRes = await axios.get("https://www.googleapis.com/drive/v3/about", {
      headers: { Authorization: `Bearer ${req.user.google.access_token}` },
      params: { fields: "storageQuota" },
    });

    const quota = driveRes.data.storageQuota;
    const used = parseInt(quota.usage, 10);
    const allocated = parseInt(quota.limit, 10);
    const used_percent = Math.round((used / allocated) * 10000) / 100;

    res.json({ used, allocated, used_percent });
  } catch (err: any) {
    console.error("Google Drive API error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch Google Drive stats" });
  }
});
