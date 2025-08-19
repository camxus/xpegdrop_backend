import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { validationErrorHandler } from "../middleware/errorMiddleware";
import {
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
} from "@aws-sdk/client-cognito-identity-provider";
import { v4 as uuidv4 } from "uuid";
import { copyItemImage, getSignedImage, saveItemImage } from "../utils/s3";
import crypto from "crypto";
import multer from "multer";
import { lookup as mimeLookup, extension as mimeExtension } from "mime-types";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

export const uploadAvatar = upload.single("avatar");

export const signup = asyncHandler(async (req: Request, res: Response) => {
  const { error, value } = signUpSchema.validate(req.body);
  if (error) throw validationErrorHandler(error);

  const { password, email, username, first_name, last_name, bio, } =
    value as SignUpInput;

  let dropbox = typeof value.dropbox === "string" ? JSON.parse(value.dropbox as string || "{}") : value.dropbox
  let avatar = typeof value.avatar === "string" ? JSON.parse(value.avatar as string || "{}") : value.avatar

  try {
    // Cognito signup
    const command = new SignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      SecretHash: crypto
        .createHmac("SHA256", process.env.COGNITO_SECRET!)
        .update(username + process.env.COGNITO_CLIENT_ID)
        .digest("base64"),
      Username: username,
      Password: password,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "given_name", Value: first_name },
        { Name: "family_name", Value: last_name },
      ],
    });

    const response = await cognito.send(command);

    // Auto-confirm (development only)
    await cognito.send(
      new AdminConfirmSignUpCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID!,
        Username: username,
      })
    );

    const userSub = response.UserSub!;
    const key = (ext: string) => `profile_images/${userSub}.${ext}`;

    if (avatar) {
      const s3Client = new S3Client({ region: process.env.AWS_REGION });

      // Determine file extension
      const ext = avatar.key.split(".").pop();

      const destination = await copyItemImage(s3Client, { bucket: avatar.bucket, key: avatar.key }, { bucket: process.env.S3_APP_BUCKET!, key: key(ext!) })

      // Delete temp file
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: process.env.S3_TEMP_BUCKET,
          Key: avatar.key,
        })
      );

      avatar = destination
    }


    if (req.file) {
      const mimeType = req.file.mimetype; // e.g., image/png
      const ext = mimeExtension(mimeType); // e.g., 'png'

      if (!ext) {
        throw new Error("Unsupported avatar file type.");
      }


      avatar = await saveItemImage(s3Client, key(ext), req.file.buffer);
    }

    const userData = {
      user_id: userSub,
      username,
      email,
      first_name,
      last_name,
      bio: bio || null,
      avatar,
      dropbox,
      created_at: new Date().toISOString(),
    };

    await client.send(
      new PutItemCommand({
        TableName: USERS_TABLE,
        Item: marshall(userData),
      })
    );

    res.status(201).json({ user: { ...userData, avatar: await getSignedImage(s3Client, { s3location: userData.avatar }) } });
  } catch (error: any) {
    console.error("Signup error:", error);
    res.status(400).json({ error: error.message });
  }
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { error, value } = signInSchema.validate(req.body);
  if (error) throw validationErrorHandler(error);

  const { username, password } = value as SignInInput;

  try {
    const command = new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH" as AuthFlowType,
      ClientId: process.env.COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
        SECRET_HASH: crypto
          .createHmac("SHA256", process.env.COGNITO_SECRET!)
          .update(username + process.env.COGNITO_CLIENT_ID)
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
        ClientId: process.env.COGNITO_CLIENT_ID,
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
          ClientId: process.env.COGNITO_CLIENT_ID!,
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
          ClientId: process.env.COGNITO_CLIENT_ID!,
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
        UserPoolId: process.env.COGNITO_USER_POOL_ID!,
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

export const getPresignURL = asyncHandler(async (req: Request, res: Response) => {
  console.log("STARTED")
  const { bucket = '', key, content_type } = req.query;
  console.log("RECIEVED", req.query)
  
  const command = new PutObjectCommand({
    Bucket: (bucket || process.env.S3_TEMP_BUCKET) as string,
    Key: key as string,
    ContentType: content_type as string
  });
  console.log("step", command)
  
  const signedUrl = await getSignedUrl(s3Client as any, command as any, { expiresIn: 300 }); // 5 minutes
  console.log("signedUrl", signedUrl)

  res.status(200).json({
    upload_url: signedUrl,
    key,
  });
});