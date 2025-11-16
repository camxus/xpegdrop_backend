import { Request, RequestHandler, Response } from "express";
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
import multer from "multer";
import { lookup as mimeLookup, extension as mimeExtension } from "mime-types";
import { updateUserSchema } from "../utils/validation/userValidation";
import { updateTenantSchema } from "../utils/validation/tenantsValidation";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });

const TENANTS_TABLE = process.env.DYNAMODB_TENANTS_TABLE || "Tenants";
const TEMP_BUCKET = process.env.EXPRESS_S3_TEMP_BUCKET!;
const EXPRESS_S3_APP_BUCKET = process.env.EXPRESS_S3_APP_BUCKET!;

const upload = multer({
  storage: multer.memoryStorage(), // stores file in memory for direct upload to S3
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit (optional)
});

export const uploadAvatar: RequestHandler = upload.single("avatar_file");

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
 * Get tenant by handle
 */
export const getTenantByHandle = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { handle } = req.params;

  if (!handle) return res.status(400).json({ error: "Handle is required" });

  // Scan to find matching handle
  const response = await client.send(
    new ScanCommand({
      TableName: TENANTS_TABLE,
      FilterExpression: "#handle = :handle",
      ExpressionAttributeNames: {
        "#handle": "handle",
      },
      ExpressionAttributeValues: marshall({
        ":handle": handle,
      }),
    })
  );

  const items = response.Items?.map((item) => unmarshall(item)) as Tenant[] || [];
  const tenant = items[0];

  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  // check membership
  const userId = req.user?.user_id;
  const isMember = tenant.members.some((m) => m.user_id === userId);

  if (!isMember) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  // sign avatar if exists
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

  const { error, value } = updateTenantSchema.validate(req.body);
  if (error) throw validationErrorHandler(error);

  const { name, description, handle } = value;

  let avatar =
    typeof req.body.avatar === "string"
      ? JSON.parse((req.body.avatar as string) || "{}")
      : req.body.avatar;

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

  // Handle avatar upload if provided
  const key = (ext: string) => `tenant_avatars/${userId}.${ext}`;

  let updatedAvatar = avatar;

  if (avatar && (avatar as S3Location).key) {
    // Determine file extension
    const ext = avatar.key.split(".").pop();

    const destination = await copyItemImage(s3Client, { bucket: avatar.bucket, key: avatar.key }, { bucket: EXPRESS_S3_APP_BUCKET, key: key(ext!) })

    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: TEMP_BUCKET,
        Key: (avatar as S3Location).key,
      })
    );

    avatar = destination
  }

  if (req.file) {
    const mimeType = req.file.mimetype; // e.g., image/png
    const ext = mimeExtension(mimeType); // e.g., 'png'

    if (!ext) {
      throw new Error("Unsupported avatar file type.");
    }


    avatar = await saveItemImage(s3Client, undefined, key(ext), req.file.buffer);
  }

  const updateExprParts: any[] = [];
  const attrNames: Record<string, string> = {};
  const attrValues: Record<string, any> = {};

  const updateData: Record<string, any> = {
    name,
    description,
    handle,
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


/**
 * Update a member's role in a tenant
 */
export const updateMember = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { tenantId, userId } = req.params;
  const { role } = req.body; // expected role: "admin" | "editor" | "viewer"

  if (!role) return res.status(400).json({ error: "Role is required" });

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
    return res.status(403).json({ error: "Only admins can update member roles" });
  }

  const memberIndex = tenant.members.findIndex((m) => m.user_id === userId);
  if (memberIndex === -1) return res.status(404).json({ error: "Member not found" });

  // prevent removing admin role if it’s the only admin
  if (tenant.members[memberIndex].role === "admin" && role !== "admin") {
    const otherAdmins = tenant.members.filter((m) => m.user_id !== userId && m.role === "admin");
    if (otherAdmins.length === 0) {
      return res.status(400).json({ error: "Cannot remove admin role from the only admin" });
    }
  }

  tenant.members[memberIndex].role = role;
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

  res.status(200).json({ message: "Member role updated successfully", tenant });
});
