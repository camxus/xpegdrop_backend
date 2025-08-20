const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Load local .env if present

// Keys to ignore for Serverless
const rejectedKeys = ['_', 'PWD', 'OLDPWD', 'SHLVL', 'PATH', 'HOME'];

// Collect env vars dynamically but exclude rejected keys
const envVars = Object.keys(process.env)
  .filter((key) => process.env[key] !== undefined && !rejectedKeys.includes(key));

// Convert to Serverless YAML format
const lines = envVars.map((key) => {
  return `${key}: \${env:${key}}`;
});

const yamlContent = lines.join('\n');

// Output to .serverless/env.yaml
const outputPath = path.join(__dirname, '.serverless', 'env.yaml');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, yamlContent, 'utf8');

console.log(yamlContent)

console.log(`✅ Generated ${outputPath} from environment variables`);
