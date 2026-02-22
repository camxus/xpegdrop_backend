import {
    DynamoDBClient,
    QueryCommand,
    UpdateItemCommand,
    PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.AWS_REGION_CODE!;
const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || "Projects";
const SHARES_TABLE = process.env.DYNAMODB_SHARES_TABLE || "Shares";

const TARGET_USER_ID = "32a54494-f031-707e-d764-f08923d74e27";

const client = new DynamoDBClient({ region: REGION });

function extractSlug(url?: string) {
    if (!url) return null;
    const parts = url.split("/").filter(Boolean); // remove empty strings
    return parts.length ? parts[parts.length - 1] : null;
}

function extractUsername(url?: string) {
    if (!url) return null;
    const parts = url.split("/").filter(Boolean);
    return parts.length ? parts[0] : null; // first segment is username
}

async function migrate() {
    console.log("🚀 Starting migration using ProjectIndex (no scans)");

    let lastEvaluatedKey: any = undefined;
    let processed = 0;
    let updatedProjects = 0;
    let createdShares = 0;

    do {
        const result = await client.send(
            new QueryCommand({
                TableName: PROJECTS_TABLE,
                IndexName: "ProjectIndex",
                KeyConditionExpression: "user_id = :uid",
                ExpressionAttributeValues: marshall({ ":uid": TARGET_USER_ID }),
                ExclusiveStartKey: lastEvaluatedKey,
            })
        );

        const items = result.Items || [];

        for (const raw of items) {
            const project = unmarshall(raw);

            const {
                project_id,
                user_id,
                share_url,
                project_url,
                approved_emails = [],
                approved_users = [],
                is_public = false,
                can_download = false,
            } = project;

            if (!project_id) continue;
            processed++;

            let finalProjectUrl = project_url || share_url;

            if (!finalProjectUrl) {
                console.log(`⚠️ Skipping ${project_id} (no URL found)`);
                continue;
            }

            // Update project: keep only project_url
            await client.send(
                new UpdateItemCommand({
                    TableName: PROJECTS_TABLE,
                    Key: marshall({ project_id }),
                    UpdateExpression: "SET project_url = :project_url REMOVE share_url",
                    ExpressionAttributeValues: marshall({ ":project_url": finalProjectUrl }),
                })
            );

            updatedProjects++;
            console.log(`🔄 Cleaned URLs for ${project_id}`);

            const slug = extractSlug(finalProjectUrl);
            const username = extractUsername(finalProjectUrl);

            if (!slug) {
                console.log(`⚠️ No slug for ${project_id}`);
                continue;
            }

            if (!username) {
                console.log(`⚠️ No username could be extracted for ${project_id}`);
                continue;
            }

            const shareItem = {
                share_id: slug,
                project_id,
                user_id,
                mode: "collaborative",
                name: slug,
                share_url: `/${username}/s/${slug}`,
                approved_users,
                approved_emails: (approved_emails as string[]).map(email => ({
                    value: email,
                    role: "viewer",
                })),
                is_public,
                can_download,
                expires_at: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };

            try {
                await client.send(
                    new PutItemCommand({
                        TableName: SHARES_TABLE,
                        Item: marshall(shareItem, { removeUndefinedValues: true }),
                        ConditionExpression: "attribute_not_exists(share_id)",
                    })
                );
                createdShares++;
                console.log(`✅ Created share for ${project_id}`);
            } catch (err: any) {
                if (err.name === "ConditionalCheckFailedException") {
                    console.log(`↩️ Share already exists for slug: ${slug}`);
                } else {
                    throw err;
                }
            }
        }

        lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log("\n🎉 MIGRATION COMPLETE");
    console.log("Projects Processed:", processed);
    console.log("Projects Updated:", updatedProjects);
    console.log("Shares Created:", createdShares);
}

migrate().catch((err) => {
    console.error("❌ Migration failed:", err);
    process.exit(1);
});