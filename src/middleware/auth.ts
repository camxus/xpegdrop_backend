import { Request, Response, NextFunction } from 'express';
import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';


const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION_CODE,
});

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || 'Users';
const region = process.env.AWS_REGION_CODE || 'eu-west-1';
const userPoolId = process.env.COGNITO_USER_POOL_ID || '';
const audience = process.env.COGNITO_CLIENT_ID || '';

export interface AuthenticatedRequest extends Request {
  user?: any;
}

const jwksUri = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
const client = jwksClient({
  jwksUri,
  cache: true,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  if (!header.kid) return callback(new Error("No KID in token header"));
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

export interface AuthenticatedRequest extends Request {
  user?: any;
}

export const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  // Skip preflight requests
  if (req.method === 'OPTIONS') return next();

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.slice(7);

    // Verify JWT against Cognito JWKS
    const decoded: any = await new Promise((resolve, reject) => {
      jwt.verify(
        token,
        getKey,
        {
          algorithms: ['RS256'],
          audience,
          issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
        },
        (err, decodedToken) => {
          if (err) reject(err);
          else resolve(decodedToken);
        }
      );
    });

    const sub = decoded.sub;
    if (!sub) throw new Error('Token missing sub claim');

    // Fetch user data from DynamoDB
    const userResponse = await dynamo.send(
      new GetItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id: sub }),
      })
    );

    if (!userResponse.Item) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = unmarshall(userResponse.Item);
    next();
  } catch (err: any) {
    console.error('Authentication error:', err);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

