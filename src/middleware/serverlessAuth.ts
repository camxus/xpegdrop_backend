import { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Request } from "express"

const region = process.env.AWS_REGION_CODE || 'eu-west-1';
const userPoolId = process.env.COGNITO_USER_POOL_ID || '';
const audience = process.env.COGNITO_CLIENT_ID || '';
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || 'Users';

const jwksUri = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
const client = jwksClient({
  jwksUri,
  cache: true,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});


export interface AuthenticatedUser {
  sub: string;
  email?: string;
  [key: string]: any;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  if (!header.kid) return callback(new Error('No KID in token header'));
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key?.getPublicKey());
  });
}

// Generates IAM policy for API Gateway
const generatePolicy = (
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context?: Record<string, any>
): APIGatewayAuthorizerResult => ({
  principalId,
  policyDocument: {
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: resource,
      },
    ],
  },
  context,
});

// Lambda authorizer
export const authorizeHandler = async (event: APIGatewayRequestAuthorizerEvent) => {
  console.log("here")
  try {
    // Allow OPTIONS requests without auth
    if (event.httpMethod === 'OPTIONS') {
      console.log("is options")
      return generatePolicy('user', 'Allow', event.methodArn);
    }
    
    const token = event.headers?.authorization;
    if (!token || !token.startsWith('Bearer ')) {
      return generatePolicy('user', 'Deny', event.methodArn);
    }
    
    console.log("checking jwt")
    const jwtToken = token.slice(7);
    
    const decoded: any = await new Promise((resolve, reject) => {
      jwt.verify(
        jwtToken,
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
    
    console.log(decoded)
    const sub = decoded.sub;
    if (!sub) throw new Error('Token missing sub claim');

    // Attach user info to context for downstream Lambda
    return generatePolicy('user', 'Allow', event.methodArn, { sub: decoded.sub });
  } catch (err) {
    console.error('Authorization error:', err);
    return generatePolicy('user', 'Deny', event.methodArn);
  }
};
