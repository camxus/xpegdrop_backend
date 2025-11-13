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
import { S3Location, Tenant } from "../types";
import { getSignedImage, saveItemImage, copyItemImage } from "../utils/s3";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });

const TENANTS_TABLE = process.env.DYNAMODB_TENANTS_TABLE || "Tenants";
const TEMP_BUCKET = process.env.EXPRESS_S3_TEMP_BUCKET!;
const APP_BUCKET = process.env.EXPRESS_S3_APP_BUCKET!;

/**
 * Create a new tenant
 */
export const createTenant = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { name, handle, description } = req.body;

  if (!name) return res.status(400).json({ error: "Tenant name is required" });
  if (!handle) return res.status(400).json({ error: "Tenant handle is required" });
  if (!req.user) return res.status(401).json({ error: "User required" });

  const tenant_id = uuidv4();
  const created_at = new Date().toISOString();

  const tenant: Tenant = {
    tenant_id,
    name,
    handle,
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
      TableName: TENANTS_TABLE,
      Item: marshall(tenant),
    })
  );

  res.status(201).json(tenant);
});

/**
 * Get all tenants user is part of
 */
export const getTenants = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.user_id;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const response = await client.send(new ScanCommand({ TableName: TENANTS_TABLE }));
  const allTenants = response.Items?.map((item) => unmarshall(item)) as Tenant[] || [];
  const tenants = allTenants.filter((tenant: Tenant) =>
    tenant.members.some((m) => m.user_id === userId)
  );

  for (const tenant of tenants) {
    if (tenant.avatar && (tenant.avatar as S3Location).key) {
      tenant.avatar = await getSignedImage(s3Client, tenant.avatar as S3Location);
    }
  }

  res.status(200).json(tenants);
});

/**
 * Get single tenant
 */
export const getTenant = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { tenantId } = req.params;
  const response = await client.send(
    new GetItemCommand({
      TableName: TENANTS_TABLE,
      Key: marshall({ tenant_id: tenantId }),
    })
  );

  if (!response.Item) return res.status(404).json({ error: "Tenant not found" });

  const tenant = unmarshall(response.Item) as Tenant;
  const userId = req.user?.user_id;
  const isMember = tenant.members.some((m) => m.user_id === userId);

  if (!isMember) return res.status(403).json({ error: "Unauthorized" });

  if (tenant.avatar && (tenant.avatar as S3Location).key) {
    tenant.avatar = await getSignedImage(s3Client, tenant.avatar as S3Location);
  }

  res.status(200).json(tenant);
});

/**
 * Update tenant details
 */
export const updateTenant = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { tenantId } = req.params;
  const { name, description, avatar } = req.body;

  const response = await client.send(
    new GetItemCommand({
      TableName: TENANTS_TABLE,
      Key: marshall({ tenant_id: tenantId }),
    })
  );

  if (!response.Item) return res.status(404).json({ error: "Tenant not found" });
  const tenant = unmarshall(response.Item) as Tenant;

  const userId = req.user?.user_id;
  const userRole = tenant.members.find((m) => m.user_id === userId)?.role;
  if (userRole !== "admin") return res.status(403).json({ error: "Only admin can update tenant" });

  let updatedAvatar = avatar;
  if (avatar && (avatar as S3Location).bucket === TEMP_BUCKET) {
    updatedAvatar = await copyItemImage(
      s3Client,
      avatar as S3Location,
      { bucket: APP_BUCKET, key: `tenant_avatars/${tenantId}.png` }
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

  const updateData: Record<string, any> = {
    name,
    description,
    avatar: updatedAvatar,
    updated_at: new Date().toISOString(),
  };

  Object.entries(updateData).filter(
    ([, value]) => !!value
  ).forEach(([key, value], i) => {
    const nameKey = `#n${i}`;
    const valueKey = `:v${i}`;
    updateExprParts.push(`${nameKey} = ${valueKey}`);
    attrNames[nameKey] = key;
    attrValues[valueKey] = value;
  });

  await client.send(
    new UpdateItemCommand({
      TableName: TENANTS_TABLE,
      Key: marshall({ tenant_id: tenantId }),
      UpdateExpression: `SET ${updateExprParts.join(", ")}`,
      ExpressionAttributeNames: attrNames,
      ExpressionAttributeValues: marshall(attrValues),
    })
  );

  const updated = {
    ...tenant,
    ...updateData,
    avatar: (updateData.avatar || tenant.avatar) ? await getSignedImage(s3Client, updateData.avatar || tenant.avatar) : null
  }

  res.status(200).json(updated);
});

/**
 * Delete tenant
 */
export const deleteTenant = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { tenantId } = req.params;
  const response = await client.send(
    new GetItemCommand({
      TableName: TENANTS_TABLE,
      Key: marshall({ tenant_id: tenantId }),
    })
  );

  if (!response.Item) return res.status(404).json({ error: "Tenant not found" });

  const tenant = unmarshall(response.Item) as Tenant;
  const userId = req.user?.user_id;
  const userRole = tenant.members.find((m) => m.user_id === userId)?.role;
  if (userRole !== "admin") return res.status(403).json({ error: "Only admin can delete tenant" });

  await client.send(
    new DeleteItemCommand({
      TableName: TENANTS_TABLE,
      Key: marshall({ tenant_id: tenantId }),
    })
  );

  res.status(200).json({ message: "Tenant deleted successfully" });
});

/**
 * Invite a member to a tenant
 */
export const inviteMember = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { tenantId } = req.params;
  const { user_id, role = "editor" } = req.body;

  if (!user_id) return res.status(400).json({ error: "user_id is required" });

  const response = await client.send(
    new GetItemCommand({
      TableName: TENANTS_TABLE,
      Key: marshall({ tenant_id: tenantId }),
    })
  );

  if (!response.Item) return res.status(404).json({ error: "Tenant not found" });
  const tenant = unmarshall(response.Item) as Tenant;

  const requesterId = req.user?.user_id;
  const requesterRole = tenant.members.find((m) => m.user_id === requesterId)?.role;

  if (requesterRole !== "admin") {
    return res.status(403).json({ error: "Only admins can invite members" });
  }

  const alreadyMember = tenant.members.some((m) => m.user_id === user_id);
  if (alreadyMember) {
    return res.status(400).json({ error: "User is already a tenant member" });
  }

  const newMember = {
    user_id,
    role,
    joined_at: new Date().toISOString(),
    invited_by: requesterId,
  };

  tenant.members.push(newMember);
  tenant.updated_at = new Date().toISOString();

  await client.send(
    new UpdateItemCommand({
      TableName: TENANTS_TABLE,
      Key: marshall({ tenant_id: tenantId }),
      UpdateExpression: "SET #members = :members, #updated_at = :updated_at",
      ExpressionAttributeNames: {
        "#members": "members",
        "#updated_at": "updated_at",
      },
      ExpressionAttributeValues: marshall({
        ":members": tenant.members,
        ":updated_at": tenant.updated_at,
      }),
    })
  );

  res.status(200).json({ message: "Member invited successfully", tenant });
});

/**
 * Remove a member from a tenant
 */
export const removeMember = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { tenantId, userId } = req.params;

  const response = await client.send(
    new GetItemCommand({
      TableName: TENANTS_TABLE,
      Key: marshall({ tenant_id: tenantId }),
    })
  );

  if (!response.Item) return res.status(404).json({ error: "Tenant not found" });
  const tenant = unmarshall(response.Item) as Tenant;

  const requesterId = req.user?.user_id;
  const requesterRole = tenant.members.find((m) => m.user_id === requesterId)?.role;

  if (requesterRole !== "admin") {
    return res.status(403).json({ error: "Only admins can remove members" });
  }

  const memberExists = tenant.members.some((m) => m.user_id === userId);
  if (!memberExists) return res.status(404).json({ error: "Member not found" });

  // prevent removing self if other members exist
  if (requesterId === userId && tenant.members.length > 1) {
    return res.status(400).json({ error: "Admin cannot remove themselves while other members exist" });
  }

  tenant.members = tenant.members.filter((m) => m.user_id !== userId);
  tenant.updated_at = new Date().toISOString();

  await client.send(
    new UpdateItemCommand({
      TableName: TENANTS_TABLE,
      Key: marshall({ tenant_id: tenantId }),
      UpdateExpression: "SET #members = :members, #updated_at = :updated_at",
      ExpressionAttributeNames: {
        "#members": "members",
        "#updated_at": "updated_at",
      },
      ExpressionAttributeValues: marshall({
        ":members": tenant.members,
        ":updated_at": tenant.updated_at,
      }),
    })
  );

  res.status(200).json({ message: "Member removed successfully", tenant });
});
