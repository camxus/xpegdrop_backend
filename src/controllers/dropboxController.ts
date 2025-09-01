import { Request, Response } from "express"
import { asyncHandler } from "../middleware/asyncHandler"
import axios from "axios"
import { v4 as uuidv4 } from "uuid"
import { DropboxService } from "../utils/dropbox"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"
import { GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import jwt from "jsonwebtoken"
import dotenv from "dotenv"
import { AuthenticatedRequest } from "../middleware/auth"

dotenv.config();

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE })
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users"

const EXPRESS_DROPBOX_CLIENT_ID = process.env.EXPRESS_DROPBOX_CLIENT_ID!
const EXPRESS_DROPBOX_CLIENT_SECRET = process.env.EXPRESS_DROPBOX_CLIENT_SECRET!
const DROPBOX_REDIRECT_URI = `${process.env.EXPRESS_PUBLIC_BACKEND_URL!}/api/dropbox/callback` // e.g. https://your-backend.com/api/dropbox/callback

// Step 1: Generate Dropbox Auth URL
export const getDropboxAuthUrl = asyncHandler(async (req: Request, res: Response) => {
  const state = uuidv4() // use to protect against CSRF
  const url = new URL("https://www.dropbox.com/oauth2/authorize")

  url.searchParams.set("client_id", EXPRESS_DROPBOX_CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", DROPBOX_REDIRECT_URI)
  url.searchParams.set("state", state)
  url.searchParams.set("token_access_type", "offline")

  // Optionally: store the state value in session/cookie if CSRF protection is needed
  res.json({ url: url.toString() })
})

export const handleDropboxCallback = asyncHandler(async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const redirectUri = `${process.env.EXPRESS_PUBLIC_BACKEND_URL}/api/dropbox/callback`;

  // Exchange code for access token
  const tokenRes = await axios.post(
    "https://api.dropbox.com/oauth2/token",
    new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: process.env.EXPRESS_DROPBOX_CLIENT_ID!,
      client_secret: process.env.EXPRESS_DROPBOX_CLIENT_SECRET!,
      redirect_uri: redirectUri,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const { access_token, refresh_token, account_id } = tokenRes.data;

  // Use DropboxService to get user info
  const dropboxService = new DropboxService(access_token);
  const userInfo = await dropboxService.getUserInfo();

  // Create JWT with user info
  const stateToken = jwt.sign(
    {
      access_token,
      refresh_token,
      account_id,
      email: userInfo.email,
      first_name: userInfo.first_name,
      last_name: userInfo.last_name,
    },
    process.env.EXPRESS_JWT_SECRET!,
    { expiresIn: "10m" }
  );

  // Redirect to frontend with token
  res.redirect(`${process.env.EXPRESS_PUBLIC_FRONTEND_URL}?dropbox_token=${stateToken}`);
});

// Step 2: Dropbox OAuth callback
export const handleDropboxCallbackWithUpdateUser = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { code } = req.query

  if (!code) {
    return res.status(400).json({ error: "Missing code from Dropbox" })
  }

  try {
    // Exchange code for access token
    const tokenRes = await axios.post("https://api.dropbox.com/oauth2/token", null, {
      params: {
        code,
        grant_type: "authorization_code",
        client_id: EXPRESS_DROPBOX_CLIENT_ID,
        client_secret: EXPRESS_DROPBOX_CLIENT_SECRET,
        redirect_uri: DROPBOX_REDIRECT_URI,
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    })

    const {
      access_token,
      refresh_token,
    } = tokenRes.data

    // You’ll need a strategy for identifying or linking this to a user
    // For now, assume you get a `user_id` from query or session
    if (!req.user?.user_id) {
      return res.status(400).json({ error: "Missing user_id to link Dropbox" })
    }

    // Store in DynamoDB (assumes user exists)
    await client.send(
      new UpdateItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id: req.user?.user_id }),
        UpdateExpression: "SET dropbox = :dropbox",
        ExpressionAttributeValues: marshall({
          ":dropbox": {
            access_token,
            refresh_token,
          },
        }),
      })
    )

    res.redirect(`${process.env.EXPRESS_PUBLIC_FRONTEND_URL}/`)
  } catch (error: any) {
    console.error("Dropbox token exchange failed:", error)
    res.status(500).json({ error: "Dropbox authentication failed" })
  }
})

export const getDropboxStats = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.user_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!req.user.dropbox?.access_token) {
      return res.status(400).json({ error: "Dropbox not linked" });
    }

    const dropbox = new DropboxService(req.user.dropbox.access_token);

    let response;

    try {
      const accountInfo = await dropbox.getStorageSpaceUsage();

      response = {
        storage: {
          used: accountInfo.used,
          allocated: accountInfo.allocated,
          used_percent: accountInfo.used_percent,
        },
      };
    } catch (err: any) {
      if (err.status === 401 && req.user.dropbox.refresh_token) {
        try {
          await dropbox.refreshDropboxToken(req.user);
          const accountInfo = await dropbox.getStorageSpaceUsage();

          response = {
            storage: {
              used: accountInfo.used,
              allocated: accountInfo.allocated,
              used_percent: accountInfo.used_percent,
            },
          };
        } catch (refreshError) {
          console.error("Dropbox token refresh failed", refreshError);
          return res.status(500).json({ error: "Failed to refresh Dropbox token" });
        }
      } else {
        console.error("Dropbox API error:", err);
        return res.status(500).json({ error: "Failed to fetch Dropbox stats" });
      }
    }

    return res.json(response);
  } catch (error: any) {
    console.error("Dropbox token exchange failed:", error);
    return res.status(500).json({ error: "Dropbox authentication failed" });
  }
});
