import {
  DynamoDBClient,
  ScanCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({ region: "eu-west-1" });

async function migrate() {
  const scan = await client.send(
    new ScanCommand({
      TableName: "Metadata",
    }),
  );

  if (!scan.Items?.length) return;

  const putRequests = scan.Items.map((item) => {
    // Destructure image_name out, keep the rest
    const { image_name, ...rest } = item;

    return {
      PutRequest: {
        Item: {
          ...rest,
          media_name: image_name, // new key
        },
      },
    };
  });

  // DynamoDB max 25 per batch
  for (let i = 0; i < putRequests.length; i += 25) {
    await client.send(
      new BatchWriteItemCommand({
        RequestItems: {
          MetadataTemp: putRequests.slice(i, i + 25),
        },
      }),
    );
  }

  console.log("Migration complete ✅");
}

migrate();
