import { Request, Response, NextFunction } from 'express';
import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { User } from '../types';

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION_CODE,
});

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || 'Users';

export interface AuthenticatedRequest extends Request {
  user?: User;
}

export const getUserFromToken = async (token: string) => {
  try {
    // Verify token with Cognito
    const userResponse = await cognito.send(
      new GetUserCommand({
        AccessToken: token,
      })
    );

    const userAttributes = userResponse.UserAttributes?.reduce((acc, attr) => {
      if (attr.Name && attr.Value) {
        acc[attr.Name] = attr.Value;
      }
      return acc;
    }, {} as Record<string, string>) || {};

    const sub = userAttributes['sub'];
    if (!sub) {
      const error: any = new Error('Invalid token: sub not found');
      error.status = 401;
      throw error;
    }

    // Get user details from DynamoDB
    const userDetailsResponse = await client.send(
      new GetItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id: sub }),
      })
    );

    if (!userDetailsResponse.Item) {
      const error: any = new Error('User not found');
      error.status = 401;
      throw error;
    }

    return unmarshall(userDetailsResponse.Item) as User;
  } catch (err: any) {
    // Optionally log the error
    console.error('Error in getUserFromToken:', err);

    // Re-throw the error with status if missing
    if (!err.status) {
      err.status = 500;
      err.message = err.message;
    }
    throw err;
  }
};

export const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);

    const userDetails = await getUserFromToken(token)

    req.user = userDetails;

    next();
  } catch (error: any) {
    console.error('Authentication error:', error);
    return res.status(error.status || 401).json({ error: error.message || 'Invalid token' });
  }
};