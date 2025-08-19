import { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

const region = process.env.AWS_REGION_CODE || "eu-west-1";
const userPoolId = process.env.COGNITO_USER_POOL_ID || "";
const audience = process.env.COGNITO_CLIENT_ID || "";

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
      return callback(err);
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

export const authorizeHandler = async (
  event: APIGatewayRequestAuthorizerEventV2
): Promise<APIGatewayAuthorizerResult> => {
  console.log("Authorization started", audience, process.env.COGNITO_CLIENT_ID);
  const token = event.headers?.authorization;
  if (!token || !token.startsWith("Bearer ")) {
    return generatePolicy("user", "Deny", event.routeArn);
  }

  const jwtToken = token.slice(7);

  try {
    // const decoded = await new Promise((resolve, reject) => {
    //   jwt.verify(
    //     jwtToken,
    //     getKey,
    //     {
    //       algorithms: ["RS256"],
    //       audience: audience,
    //       issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    //     },
    //     (err, decodedToken) => {
    //       if (err) reject(err);
    //       else resolve(decodedToken);
    //     }
    //   );
    // });

    console.log(JSON.stringify(generatePolicy("user", "Allow", event.routeArn)), event.routeArn);

    console.log("Authorization success");
    return generatePolicy("user", "Allow", event.routeArn);
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
