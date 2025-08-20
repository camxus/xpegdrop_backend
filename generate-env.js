const fs = require("fs");
const path = require("path");
require("dotenv").config(); // load local .env if present

// Regex pattern: only keep env vars starting with these prefixes
const allowedPattern = /^(AWS_|SERVERLESS_|EXPRESS_|PUBLIC_)/;

// Collect env vars dynamically
const envVars = Object.keys(process.env).filter(
  (key) => process.env[key] !== undefined && allowedPattern.test(key)
);

// Convert to .env format
const lines = envVars.map((key) => `${key}=${process.env[key]}`);

console.log(lines)

// Output to .env
const outputPath = path.join(__dirname, ".env");
fs.writeFileSync(outputPath, lines.join("\n"), "utf8");

console.log(`✅ Generated ${outputPath} from environment variables`);
