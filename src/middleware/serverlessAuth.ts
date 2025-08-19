import { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
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
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

export const authorizeHandler = async (
  event: APIGatewayRequestAuthorizerEventV2
) => {
  console.log("Authorization started", audience);

  const token = event.headers?.authorization;
  if (!token || !token.startsWith("Bearer ")) {
    return { isAuthorized: false };
  }

  const jwtToken = token.slice(7);

  try {
    // const decoded = await new Promise<jwt.JwtPayload>((resolve, reject) => {
    //   jwt.verify(
    //     jwtToken,
    //     getKey,
    //     {
    //       algorithms: ["RS256"],
    //       audience,
    //       issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    //     },
    //     (err, decodedToken) => {
    //       if (err) reject(err);
    //       else resolve(decodedToken as jwt.JwtPayload);
    //     }
    //   );
    // });

    console.log("Authorization success");

    return {
      isAuthorized: true,
      // context: {
      //   sub: decoded.sub,
      //   username: decoded["cognito:username"] || decoded["username"],
      // },
    };
  } catch (err) {
    console.error("Authorization error:", err);
    return { isAuthorized: false };
  }
};
