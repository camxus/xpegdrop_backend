/**
 * Migration script: rename `image_name` → `media_name` in Notes and Ratings tables
 * Usage: `ts-node migrate-media-name.ts`
 */

import { DynamoDBClient, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.AWS_REGION || "eu-west-1";
const NOTES_TABLE = process.env.NOTES_TABLE || "Notes";
const RATINGS_TABLE = process.env.RATINGS_TABLE || "Ratings";

const client = new DynamoDBClient({ region: REGION });

async function migrateTable(tableName: string, oldField: string, newField: string) {
  console.log(`Migrating table: ${tableName}`);

  // Scan all items
  let lastEvaluatedKey: any = undefined;
  do {
    const scanCmd = new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastEvaluatedKey,
    });

    const res = await client.send(scanCmd);

    for (const item of res.Items ?? []) {
      const data = unmarshall(item);
      if (!(oldField in data)) continue;

      const oldValue = data[oldField];

      // Prepare UpdateExpression
      const updateCmd = new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ [`${tableName === NOTES_TABLE ? "note_id" : "rating_id"}`]: data[`${tableName === NOTES_TABLE ? "note_id" : "rating_id"}`] }),
        UpdateExpression: `SET ${newField} = :val REMOVE ${oldField}`,
        ExpressionAttributeValues: marshall({ ":val": oldValue }),
      });

      await client.send(updateCmd);
      console.log(`Migrated item ${data[tableName === NOTES_TABLE ? "note_id" : "rating_id"]}`);
    }

    lastEvaluatedKey = res.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`Migration complete for table: ${tableName}`);
}

async function main() {
  try {
    await migrateTable(NOTES_TABLE, "image_name", "media_name");
    await migrateTable(RATINGS_TABLE, "image_name", "media_name");
    console.log("✅ Migration finished successfully");
  } catch (err) {
    console.error("Migration failed:", err);
  }
}

main();
