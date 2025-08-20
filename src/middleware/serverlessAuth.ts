import { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

const region = process.env.AWS_REGION_CODE || "eu-west-1";
const userPoolId = process.env.EXPRESS_COGNITO_USER_POOL_ID || "";
const audience = process.env.EXPRESS_COGNITO_CLIENT_ID || "";

const jwksUri = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;

const client = jwksClient({
  jwksUri,
  cache: true,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  if (!header.kid) {
    return callback(new Error("No KID in token header"));
  }

  client.getSigningKey(header.kid, function (err, key) {
    if (err) {
      console.error("Error fetching signing key:", err);
      return callback(err);
    }

    const signingKey = key?.getPublicKey();
    if (!signingKey) {
      const msg = `Could not get public key for kid: ${header.kid}`;
      console.error(msg);
      return callback(new Error(msg));
    }

    callback(null, signingKey);
  });
}

export const authorizeHandler = async (
  event: APIGatewayRequestAuthorizerEventV2
): Promise<APIGatewayAuthorizerResult> => {
  const token = event.headers?.authorization;
  if (!token || !token.startsWith("Bearer ")) {
    return generatePolicy("user", "Deny", event.routeArn);
  }

  const jwtToken = token.slice(7);

  try {
    const decoded = await new Promise((resolve, reject) => {
      jwt.verify(
        jwtToken,
        getKey,
        {
          algorithms: ["RS256"],
          issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
        },
        (err, decodedToken) => {
          if (err) {
            console.error("JWT verification error:", err);
            return reject(err);
          }

          if (!decodedToken) {
            return reject(new Error("Decoded token is undefined"));
          }

          const clientId = (decodedToken as any).client_id;
          if (clientId !== audience.trim()) {
            return reject(
              new Error(`Invalid client_id: expected ${audience}, got ${clientId}`)
            );
          }
          resolve(decodedToken);
        }
      );
    });


    return generatePolicy("user", "Allow", event.routeArn, {
      sub: (decoded as any).sub,
      username: (decoded as any).username,
      client_id: (decoded as any).client_id,
    });
  } catch (err) {
    console.error("Authorization error:", err);
    return generatePolicy("user", "Deny", event.routeArn);
  }
};

const generatePolicy = (
  principalId: string,
  effect: "Allow" | "Deny",
  resource: string,
  context?: Record<string, any>
) => ({
  principalId,
  policyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Action: "execute-api:Invoke",
        Effect: effect,
        Resource: resource,
      },
    ],
  },
  context,
});
