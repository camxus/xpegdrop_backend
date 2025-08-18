import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { validationErrorHandler } from "../middleware/errorMiddleware";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
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
import { getSignedImage, saveItemImage } from "../utils/s3";
import crypto from "crypto";
import multer from "multer";
import { lookup as mimeLookup, extension as mimeExtension } from "mime-types";

const upload = multer({
  storage: multer.memoryStorage(), // stores file in memory for direct upload to S3
  limits: { fileSize: 5 * 1024 * 1024 * 10 }, // 50MB limit (optional)
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

  const { password, email, username, first_name, last_name, bio, dropbox } =
    value as SignUpInput;

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

    // const response = await cognito.send(command);

    // Auto-confirm (development only)
    // await cognito.send(
    //   new AdminConfirmSignUpCommand({
    //     UserPoolId: process.env.COGNITO_USER_POOL_ID!,
    //     Username: username,
    //   })
    // );

    const userSub = "62c59454-2021-703a-0b4d-de7b62dffb92"// || response.UserSub!;
    let avatar_url = null;

    if (req.file) {
      const mimeType = req.file.mimetype; // e.g., image/png
      const ext = mimeExtension(mimeType); // e.g., 'png'

      if (!ext) {
        throw new Error("Unsupported avatar file type.");
      }

      const key = `profile_images/${userSub}.${ext}`;

      avatar_url = await saveItemImage(s3Client, key, req.file.buffer);
    }
    const userData = {
      user_id: userSub,
      username,
      email,
      first_name,
      last_name,
      bio: bio || null,
      avatar_url,
      dropbox: typeof dropbox === "string" ? JSON.parse(dropbox as string || "{}") : dropbox,
      created_at: new Date().toISOString(),
    };

    await client.send(
      new PutItemCommand({
        TableName: USERS_TABLE,
        Item: marshall(userData),
      })
    );

    res.status(201).json({ user: userData });
  } catch (error: any) {
    console.error("Signup error:", error);
    res.status(400).json({ error: error.message });
  }
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  console.log("VALIDATION ERROR", req.body)
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
      if (userDetails.avatar_url) {
        userDetails.avatar_url = await getSignedImage(
          s3Client,
          userDetails.avatar_url.key
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
