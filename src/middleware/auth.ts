import { Request, Response, NextFunction } from 'express';
import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION_CODE,
});

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || 'Users';

export interface AuthenticatedRequest extends Request {
  user?: any;
}

export const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  // Skip preflight
  if (req.method === "OPTIONS") return next();

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return safeRes(res, 401, { error: "No token provided" });
    }

    const token = authHeader.substring(7);

    // Verify token with Cognito
    const userResponse = await cognito.send(new GetUserCommand({ AccessToken: token }));

    const userAttributes = userResponse.UserAttributes?.reduce((acc, attr) => {
      if (attr.Name && attr.Value) acc[attr.Name] = attr.Value;
      return acc;
    }, {} as Record<string, string>) || {};

    const sub = userAttributes["sub"];

    // Get user details from DynamoDB
    const userDetailsResponse = await client.send(
      new GetItemCommand({ TableName: USERS_TABLE, Key: marshall({ user_id: sub }) })
    );

    if (!userDetailsResponse.Item) {
      return safeRes(res, 401, { error: "User not found" });
    }

    req.user = unmarshall(userDetailsResponse.Item);
    next();
  } catch (error: any) {
    console.error("Authentication error:", error);

    // Cognito token expired or other auth errors
    return safeRes(res, 401, { error: "Invalid or expired token" });
  }
};

function safeRes(res: any, status: number, body: any) {
  if (res && typeof res.status === "function" && typeof res.json === "function") {
    return res.status(status).json(body);
  }
  // If res is not a normal Express response (serverless context), just log
  console.log("Response fallback:", status, body);
  return null;
}