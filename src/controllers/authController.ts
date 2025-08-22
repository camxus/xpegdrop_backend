import { Request, RequestHandler, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { validationErrorHandler } from "../middleware/errorMiddleware";
import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  signUpSchema,
  signInSchema,
  forgotPasswordSchema,
  confirmPasswordSchema,
  newPasswordSchema,
} from "../utils/validation/authValidation";
import { SignInInput, SignUpInput } from "../types";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  AdminConfirmSignUpCommand,
  InitiateAuthCommand,
  AuthFlowType,
  GetUserCommand,
  AdminSetUserPasswordCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { v4 as uuidv4 } from "uuid";
import { copyItemImage, getSignedImage, saveItemImage } from "../utils/s3";
import crypto from "crypto";
import multer from "multer";
import { lookup as mimeLookup, extension as mimeExtension } from "mime-types";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AuthenticatedRequest } from "../middleware/auth";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const upload = multer({
  storage: multer.memoryStorage(), // stores file in memory for direct upload to S3
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit (optional)
});

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION_CODE,
});

const sqs = new SQSClient({ region: process.env.AWS_REGION_CODE });

export const uploadAvatar: RequestHandler = upload.single("avatar_file");

export const signup = asyncHandler(async (req: Request, res: Response) => {
  const { error, value } = signUpSchema.validate(req.body);
  if (error) throw validationErrorHandler(error);

  const { password, email, username, first_name, last_name, bio } =
    value as SignUpInput;

  let dropbox =
    typeof value.dropbox === "string"
      ? JSON.parse((value.dropbox as string) || "{}")
      : value.dropbox;

  let avatar =
    typeof value.avatar === "string"
      ? JSON.parse((value.avatar as string) || "{}")
      : value.avatar;

  // If avatar uploaded as multipart file, encode buffer (since SQS messages are text only)
  let avatarFile: { buffer: string; mimetype: string } | null = null;
  if (req.file) {
    avatarFile = {
      buffer: req.file.buffer.toString("base64"),
      mimetype: req.file.mimetype,
    };
  }

  const signupPayload = {
    password,
    email,
    username,
    first_name,
    last_name,
    bio: bio || null,
    dropbox,
    avatar,
    avatarFile,
  };

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.SIGNUP_QUEUE_URL!, // points to SignupQueue
        MessageBody: JSON.stringify(signupPayload),
      })
    );

    res.status(202).json({
      message: "Signup request received and is being processed.",
    });
  } catch (err: any) {
    console.error("Failed to enqueue signup request:", err);
    res.status(500).json({ error: "Failed to process signup request" });
  }
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { error, value } = signInSchema.validate(req.body);
  if (error) throw validationErrorHandler(error);

  const { username, password } = value as SignInInput;

  try {
    const command = new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH" as AuthFlowType,
      ClientId: process.env.EXPRESS_COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
        SECRET_HASH: crypto
          .createHmac("SHA256", process.env.EXPRESS_COGNITO_SECRET!)
          .update(username + process.env.EXPRESS_COGNITO_CLIENT_ID)
          .digest("base64"),
      },
    });

    const response = await cognito.send(command);

    if (!response.AuthenticationResult?.AccessToken) {
      return res.status(401).json({ error: "Authentication failed" });
    }

    // Get user info from Cognito
    const userResponse = await cognito.send(
      new GetUserCommand({
        AccessToken: response.AuthenticationResult.AccessToken,
      })
    );

    const userAttributes =
      userResponse.UserAttributes?.reduce((acc, attr) => {
        if (attr.Name && attr.Value) {
          acc[attr.Name] = attr.Value;
        }
        return acc;
      }, {} as Record<string, string>) || {};

    const sub = userAttributes["sub"];

    // Get user details from DynamoDB
    const userDetailsResponse = await client.send(
      new GetItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id: sub }),
      })
    );

    let userDetails = null;
    if (userDetailsResponse.Item) {
      userDetails = unmarshall(userDetailsResponse.Item);

      // Get signed URL for avatar if it exists
      if (userDetails.avatar) {
        userDetails.avatar = await getSignedImage(
          s3Client,
          userDetails.avatar.key
        );
      }
    }

    res.status(200).json({
      token: {
        accessToken: response.AuthenticationResult.AccessToken,
        refreshToken: response.AuthenticationResult.RefreshToken,
        idToken: response.AuthenticationResult.IdToken,
        expiresIn: response.AuthenticationResult.ExpiresIn,
      },
      user: userDetails,
    });
  } catch (error: any) {
    console.error("Login error:", error);
    res.status(401).json({ error: error.message });
  }
});

export const refreshToken = asyncHandler(
  async (req: Request, res: Response) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        error: "Refresh token is required",
      });
    }

    try {
      const command = new InitiateAuthCommand({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: process.env.EXPRESS_COGNITO_CLIENT_ID,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
        },
      });

      const response = await cognito.send(command);

      return res.status(200).json({
        accessToken: response.AuthenticationResult?.AccessToken,
        refreshToken: response.AuthenticationResult?.RefreshToken,
        idToken: response.AuthenticationResult?.IdToken,
        expiresIn: response.AuthenticationResult?.ExpiresIn,
      });
    } catch (error: any) {
      return res.status(401).json({
        error: error.message || "Failed to refresh token",
      });
    }
  }
);

export const forgotPassword = asyncHandler(
  async (req: Request, res: Response) => {
    const { error, value } = forgotPasswordSchema.validate(req.body);
    if (error) throw validationErrorHandler(error);

    const { email } = value;

    try {
      await cognito.send(
        new ForgotPasswordCommand({
          ClientId: process.env.EXPRESS_COGNITO_CLIENT_ID!,
          Username: email,
        })
      );

      res.status(200).json({ message: "Password reset code sent" });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

export const confirmPassword = asyncHandler(
  async (req: Request, res: Response) => {
    const { error, value } = confirmPasswordSchema.validate(req.body);
    if (error) throw validationErrorHandler(error);

    const { email, code, newPassword } = value;

    try {
      await cognito.send(
        new ConfirmForgotPasswordCommand({
          ClientId: process.env.EXPRESS_COGNITO_CLIENT_ID!,
          Username: email,
          ConfirmationCode: code,
          Password: newPassword,
        })
      );

      res.status(200).json({ message: "Password reset successful" });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

export const setNewPassword = asyncHandler(
  async (req: Request, res: Response) => {
    const { error, value } = newPasswordSchema.validate(req.body);
    if (error) throw validationErrorHandler(error);

    const { email, newPassword } = value;

    try {
      const command = new AdminSetUserPasswordCommand({
        UserPoolId: process.env.EXPRESS_COGNITO_USER_POOL_ID!,
        Username: email,
        Password: newPassword,
        Permanent: true,
      });

      await cognito.send(command);

      res.status(200).json({ message: "Password updated successfully" });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

export const getPresignURL = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { bucket = '', key, content_type } = req.query;

  const command = new PutObjectCommand({
    Bucket: (bucket || process.env.EXPRESS_S3_TEMP_BUCKET) as string,
    Key: key as string,
    ContentType: content_type as string
  });

  const signedUrl = await getSignedUrl(s3Client as any, command as any, { expiresIn: 300 }); // 5 minutes

  res.status(200).json({
    upload_url: signedUrl,
    key,
  });
});

export const getPresignPOST = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { key, content_type } = req.query;

  // ✅ Force users into their own folder (no arbitrary keys)
  const userId = req.user?.user_id; // adjust if you store differently

  // ✅ Max file size: 50 MB
  const MAX_FILE_SIZE = 50 * 1024 * 1024;

  const presignedPost = await createPresignedPost(s3Client as any, {
    Bucket: process.env.EXPRESS_S3_TEMP_BUCKET as string,
    Key: key as string,
    Conditions: [
      ["content-length-range", 0, MAX_FILE_SIZE],              // enforce file size
      ["eq", "$Content-Type", content_type as string],         // enforce MIME type
      ["starts-with", "$key", `${userId}/`],      // enforce key prefix
    ],
    Fields: {
      "Content-Type": content_type as string,
    },
    Expires: 300, // URL valid for 5 minutes
  });

  res.status(200).json({
    upload_url: presignedPost.url,
    fields: presignedPost.fields,
    key,
    max_size: MAX_FILE_SIZE,
  });
});