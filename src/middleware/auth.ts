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
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);

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

    // Get user details from DynamoDB
    const userDetailsResponse = await client.send(
      new GetItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id: sub }),
      })
    );

    if (!userDetailsResponse.Item) {
      return res.status(401).json({ error: 'User not found' });
    }

    const userDetails = unmarshall(userDetailsResponse.Item);
    req.user = userDetails;
  
    next();
  } catch (error: any) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
};