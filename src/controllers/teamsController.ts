import { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { validationErrorHandler } from "../middleware/errorMiddleware";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { AuthenticatedRequest } from "../middleware/auth";
import { Team, S3Location } from "../types";
import { getSignedImage, saveItemImage, copyItemImage } from "../utils/s3";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });

const TEAMS_TABLE = process.env.DYNAMODB_TEAMS_TABLE || "Teams";
const TEMP_BUCKET = process.env.EXPRESS_S3_TEMP_BUCKET!;
const APP_BUCKET = process.env.EXPRESS_S3_APP_BUCKET!;

/**
 * Create a new team
 */
export const createTeam = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { name, description } = req.body;

  if (!name) return res.status(400).json({ error: "Team name is required" });
  if (!req.user) return res.status(401).json({ error: "User required" });

  const team_id = uuidv4();
  const created_at = new Date().toISOString();

  const team: Team = {
    team_id,
    name,
    description,
    members: [
      {
        user_id: req.user.user_id,
        role: "admin",
        joined_at: created_at,
      },
    ],
    created_at,
  };

  await client.send(
    new PutItemCommand({
      TableName: TEAMS_TABLE,
      Item: marshall(team),
    })
  );

  res.status(201).json(team);
});

/**
 * Get all teams user is part of
 */
export const getTeams = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.user_id;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const response = await client.send(new ScanCommand({ TableName: TEAMS_TABLE }));
  const allTeams = response.Items?.map((item) => unmarshall(item)) as Team[] || [];
  const teams = allTeams.filter((team: Team) =>
    team.members.some((m) => m.user_id === userId)
  );

  for (const team of teams) {
    if (team.avatar && (team.avatar as S3Location).key) {
      team.avatar = await getSignedImage(s3Client, team.avatar as S3Location);
    }
  }

  res.status(200).json(teams);
});

/**
 * Get single team
 */
export const getTeam = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { teamId } = req.params;
  const response = await client.send(
    new GetItemCommand({
      TableName: TEAMS_TABLE,
      Key: marshall({ team_id: teamId }),
    })
  );

  if (!response.Item) return res.status(404).json({ error: "Team not found" });

  const team = unmarshall(response.Item) as Team;
  const userId = req.user?.user_id;
  const isMember = team.members.some((m) => m.user_id === userId);

  if (!isMember) return res.status(403).json({ error: "Unauthorized" });

  if (team.avatar && (team.avatar as S3Location).key) {
    team.avatar = await getSignedImage(s3Client, team.avatar as S3Location);
  }

  res.status(200).json(team);
});

/**
 * Update team details
 */
export const updateTeam = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { teamId } = req.params;
  const { name, description, avatar } = req.body;

  const response = await client.send(
    new GetItemCommand({
      TableName: TEAMS_TABLE,
      Key: marshall({ team_id: teamId }),
    })
  );

  if (!response.Item) return res.status(404).json({ error: "Team not found" });
  const team = unmarshall(response.Item) as Team;

  const userId = req.user?.user_id;
  const userRole = team.members.find((m) => m.user_id === userId)?.role;
  if (userRole !== "admin") return res.status(403).json({ error: "Only admin can update team" });

  let updatedAvatar = avatar;
  if (avatar && (avatar as S3Location).bucket === TEMP_BUCKET) {
    updatedAvatar = await copyItemImage(
      s3Client,
      avatar as S3Location,
      { bucket: APP_BUCKET, key: `team_avatars/${teamId}.png` }
    );

    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: TEMP_BUCKET,
        Key: (avatar as S3Location).key,
      })
    );
  }

  const updateExprParts: any[] = [];
  const attrNames: Record<string, string> = {};
  const attrValues: Record<string, any> = {};
  const updateData: any = { updated_at: new Date().toISOString() };

  if (name) updateData.name = name;
  if (description) updateData.description = description;
  if (updatedAvatar) updateData.avatar = updatedAvatar;

  Object.entries(updateData).forEach(([key, value], i) => {
    const nameKey = `#n${i}`;
    const valueKey = `:v${i}`;
    updateExprParts.push(`${nameKey} = ${valueKey}`);
    attrNames[nameKey] = key;
    attrValues[valueKey] = value;
  });

  await client.send(
    new UpdateItemCommand({
      TableName: TEAMS_TABLE,
      Key: marshall({ team_id: teamId }),
      UpdateExpression: `SET ${updateExprParts.join(", ")}`,
      ExpressionAttributeNames: attrNames,
      ExpressionAttributeValues: marshall(attrValues),
    })
  );

  res.status(200).json({ message: "Team updated successfully" });
});

/**
 * Delete team
 */
export const deleteTeam = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { teamId } = req.params;
  const response = await client.send(
    new GetItemCommand({
      TableName: TEAMS_TABLE,
      Key: marshall({ team_id: teamId }),
    })
  );

  if (!response.Item) return res.status(404).json({ error: "Team not found" });

  const team = unmarshall(response.Item) as Team;
  const userId = req.user?.user_id;
  const userRole = team.members.find((m) => m.user_id === userId)?.role;
  if (userRole !== "admin") return res.status(403).json({ error: "Only admin can delete team" });

  await client.send(
    new DeleteItemCommand({
      TableName: TEAMS_TABLE,
      Key: marshall({ team_id: teamId }),
    })
  );

  res.status(200).json({ message: "Team deleted successfully" });
});

/**
 * Invite a member to a team
 */
export const inviteMember = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { teamId } = req.params;
  const { user_id, role = "member" } = req.body;

  if (!user_id) return res.status(400).json({ error: "user_id is required" });

  const response = await client.send(
    new GetItemCommand({
      TableName: TEAMS_TABLE,
      Key: marshall({ team_id: teamId }),
    })
  );

  if (!response.Item) return res.status(404).json({ error: "Team not found" });
  const team = unmarshall(response.Item) as Team;

  const requesterId = req.user?.user_id;
  const requesterRole = team.members.find((m) => m.user_id === requesterId)?.role;

  if (requesterRole !== "admin") {
    return res.status(403).json({ error: "Only admins can invite members" });
  }

  const alreadyMember = team.members.some((m) => m.user_id === user_id);
  if (alreadyMember) {
    return res.status(400).json({ error: "User is already a team member" });
  }

  const newMember = {
    user_id,
    role,
    joined_at: new Date().toISOString(),
    invited_by: requesterId,
  };

  team.members.push(newMember);
  team.updated_at = new Date().toISOString();

  await client.send(
    new UpdateItemCommand({
      TableName: TEAMS_TABLE,
      Key: marshall({ team_id: teamId }),
      UpdateExpression: "SET #members = :members, #updated_at = :updated_at",
      ExpressionAttributeNames: {
        "#members": "members",
        "#updated_at": "updated_at",
      },
      ExpressionAttributeValues: marshall({
        ":members": team.members,
        ":updated_at": team.updated_at,
      }),
    })
  );

  res.status(200).json({ message: "Member invited successfully", team });
});

/**
 * Remove a member from a team
 */
export const removeMember = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { teamId, userId } = req.params;

  const response = await client.send(
    new GetItemCommand({
      TableName: TEAMS_TABLE,
      Key: marshall({ team_id: teamId }),
    })
  );

  if (!response.Item) return res.status(404).json({ error: "Team not found" });
  const team = unmarshall(response.Item) as Team;

  const requesterId = req.user?.user_id;
  const requesterRole = team.members.find((m) => m.user_id === requesterId)?.role;

  if (requesterRole !== "admin") {
    return res.status(403).json({ error: "Only admins can remove members" });
  }

  const memberExists = team.members.some((m) => m.user_id === userId);
  if (!memberExists) return res.status(404).json({ error: "Member not found" });

  // prevent removing self if other members exist
  if (requesterId === userId && team.members.length > 1) {
    return res.status(400).json({ error: "Admin cannot remove themselves while other members exist" });
  }

  team.members = team.members.filter((m) => m.user_id !== userId);
  team.updated_at = new Date().toISOString();

  await client.send(
    new UpdateItemCommand({
      TableName: TEAMS_TABLE,
      Key: marshall({ team_id: teamId }),
      UpdateExpression: "SET #members = :members, #updated_at = :updated_at",
      ExpressionAttributeNames: {
        "#members": "members",
        "#updated_at": "updated_at",
      },
      ExpressionAttributeValues: marshall({
        ":members": team.members,
        ":updated_at": team.updated_at,
      }),
    })
  );

  res.status(200).json({ message: "Member removed successfully", team });
});
