const fs = require("fs");
const path = require("path");
require("dotenv").config(); // load local .env if present

const reservedKeys = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];


// Regex pattern: only keep env vars starting with these prefixes
const allowedPattern = /^(AWS_|SERVERLESS_|EXPRESS_|PUBLIC_)/;

// Collect env vars dynamically
const envVars = Object.keys(process.env).filter(
  (key) => process.env[key] !== undefined && allowedPattern.test(key) && !reservedKeys.includes(key)
);

// Convert to .env format
const lines = envVars.map((key) => `${key}=${process.env[key]}`);

// Output to .env
const outputPath = path.join(__dirname, ".env");
fs.writeFileSync(outputPath, lines.join("\n"), "utf8");

console.log(`✅ Generated ${outputPath} from environment variables`);
