const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Load variables from .env into process.env

// Collect all env vars in current Node process (from GitHub Actions or .env)
const envVars = Object.keys(process.env).filter((key) => process.env[key] !== undefined);

// Convert to YAML format
const lines = envVars.map((key) => {
  const value = process.env[key];
  // Quote values that contain special YAML characters
  const needsQuotes = /[:#&{}[\],*?|<>!%@`"'\\]/.test(value);
  const safeValue = needsQuotes ? `"${value}"` : value;
  return `${key}: ${safeValue}`;
});

const yamlContent = lines.join('\n');

// Output to .serverless/env.yaml
const outputPath = path.join(__dirname, '.serverless', 'env.yaml');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, yamlContent, 'utf8');

console.log(`✅ Generated ${outputPath} from environment variables (GitHub or .env)`);
