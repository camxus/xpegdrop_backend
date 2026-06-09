import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { AgentSessionItem, AgentInteractionItem } from '../types/agent';

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });

export const AGENT_SESSIONS_TABLE = process.env.DYNAMODB_AGENT_SESSIONS_TABLE || 'AgentSessions';
export const AGENT_INTERACTIONS_TABLE = process.env.DYNAMODB_AGENT_INTERACTIONS_TABLE || 'AgentInteractions';

export async function putAgentSession(item: AgentSessionItem) {
  return client.send(
    new PutItemCommand({
      TableName: AGENT_SESSIONS_TABLE,
      Item: marshall(item, { removeUndefinedValues: true }),
    })
  );
}

export async function getAgentSession(sessionId: string) {
  const result = await client.send(
    new GetItemCommand({
      TableName: AGENT_SESSIONS_TABLE,
      Key: marshall({ sessionId }),
    })
  );
  return result.Item ? (unmarshall(result.Item) as AgentSessionItem) : null;
}

export async function queryUserSessions(userId: string) {
  const result = await client.send(
    new ScanCommand({
      TableName: AGENT_SESSIONS_TABLE,
      FilterExpression: 'userId = :userId',
      ExpressionAttributeValues: marshall({ ':userId': userId }),
    })
  );
  return (result.Items || []).map((item) => unmarshall(item) as AgentSessionItem);
}

export async function updateSessionStatus(sessionId: string, status: AgentSessionItem['status']) {
  return client.send(
    new UpdateCommand({
      TableName: AGENT_SESSIONS_TABLE,
      Key: marshall({ sessionId }),
      UpdateExpression: 'SET #status = :status, lastActivityAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':status': status,
        ':now': Date.now(),
      }),
    })
  );
}

export async function putAgentInteraction(item: AgentInteractionItem) {
  return client.send(
    new PutItemCommand({
      TableName: AGENT_INTERACTIONS_TABLE,
      Item: marshall(item, { removeUndefinedValues: true }),
    })
  );
}

export async function querySessionInteractions(sessionId: string, limit = 50) {
  const result = await client.send(
    new QueryCommand({
      TableName: AGENT_INTERACTIONS_TABLE,
      KeyConditionExpression: 'sessionId = :sessionId',
      ExpressionAttributeValues: marshall({ ':sessionId': sessionId }),
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return (result.Items || []).map((item) => unmarshall(item) as AgentInteractionItem);
}
