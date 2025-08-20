import { Request, Response } from "express"
import { asyncHandler } from "../middleware/asyncHandler"
import axios from "axios"
import { v4 as uuidv4 } from "uuid"
import { DropboxService } from "../utils/dropbox"
import { marshall } from "@aws-sdk/util-dynamodb"
import { PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import jwt from "jsonwebtoken"
import dotenv from "dotenv"

dotenv.config();

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE })
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users"

const EXPRESS_DROPBOX_CLIENT_ID = process.env.EXPRESS_DROPBOX_CLIENT_ID!
const EXPRESS_DROPBOX_CLIENT_SECRET = process.env.EXPRESS_DROPBOX_CLIENT_SECRET!
const DROPBOX_REDIRECT_URI =`${process.env.EXPRESS_PUBLIC_BACKEND_URL!}/api/dropbox/callback` // e.g. https://your-backend.com/api/dropbox/callback

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
  
  const tokenRes = await axios.post("https://api.dropbox.com/oauth2/token", new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: process.env.EXPRESS_DROPBOX_CLIENT_ID!,
    client_secret: process.env.EXPRESS_DROPBOX_CLIENT_SECRET!,
    redirect_uri: redirectUri,
  }), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  const { access_token, refresh_token, account_id, uid } = tokenRes.data;

  // Optional: Save these in a temporary session store or JWT
  const stateToken = jwt.sign({ access_token, refresh_token, account_id }, process.env.EXPRESS_JWT_SECRET!, { expiresIn: "10m" });

  // Redirect to /signup with a token param
  res.redirect(`${process.env.EXPRESS_PUBLIC_FRONTEND_URL}/signup?dropbox_token=${stateToken}`);
});

// Step 2: Dropbox OAuth callback
export const handleDropboxCallbackWithUpdateUser = asyncHandler(async (req: Request, res: Response) => {
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
      account_id,
      refresh_token,
      expires_in,
      token_type,
      scope,
      uid,
    } = tokenRes.data

    // You’ll need a strategy for identifying or linking this to a user
    // For now, assume you get a `user_id` from query or session
    const { user_id } = req.query
    if (!user_id) {
      return res.status(400).json({ error: "Missing user_id to link Dropbox" })
    }

    // Store in DynamoDB (assumes user exists)
    await client.send(
      new UpdateItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id }),
        UpdateExpression: "SET dropbox = :dropbox",
        ExpressionAttributeNames: {
          // Remove expression attribute names since we're not using reserved words
        },
        ExpressionAttributeValues: marshall({
          ":dropbox": {
            access_token,
            refresh_token,
          },
        }),
      })
    )

    res.redirect(`${process.env.EXPRESS_PUBLIC_FRONTEND_URL}/onboarding/dropbox-success`)
  } catch (error: any) {
    console.error("Dropbox token exchange failed:", error)
    res.status(500).json({ error: "Dropbox authentication failed" })
  }
})
