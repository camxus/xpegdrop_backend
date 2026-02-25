import { asyncHandler } from "../middleware/asyncHandler";
import { validationErrorHandler } from "../middleware/errorMiddleware";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  createProjectSchema,
  updateProjectSchema,
} from "../utils/validation/projectValidation";
import axios from "axios";
import { CreateProjectInput, UpdateProjectInput, Project, S3Location, User, Tenant, ProjectHistoryType, Share } from "../types";
import { v4 as uuidv4 } from "uuid";
import { DropboxService } from "../lib/dropbox";
import { AuthenticatedRequest, getUserFromToken } from "../middleware/auth";
import { Request, RequestHandler, Response } from "express";
import multer from "multer";
import { deleteItemImage, getItemFile, getSignedImage, moveFolder, s3ObjectExists, saveItemImage } from "../utils/s3";
import { S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { getProjectWithMedia, getHandleUrl } from "../utils/helpers/project";
import { BackblazeService } from "../lib/backblaze";
import { handler as create } from "../sqs/workers/project/create";
import { Context, SQSEvent } from "aws-lambda";
import { createProjectHistoryItem } from "./historyController";
// import { GoogleDriveService } from "../lib/drive";
import { handler as add } from "../sqs/workers/project/addFiles";
import { deleteImageMetadata } from "./metadataController";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });

const B2_BUCKET_ID = process.env.EXPRESS_B2_BUCKET_ID!;
const THUMBNAILS_BUCKET = process.env.EXPRESS_S3_THUMBNAILS_BUCKET!;

const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || "Projects";
const TENANTS_TABLE = process.env.DYNAMODB_TENANTS_TABLE || "Tenants";
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";
const SHARES_TABLE = process.env.DYNAMODB_SHARES_TABLE || "Shares";
const METADATA_TABLE = process.env.DYNAMODB_IMAGE_METADATA_TABLE || "Metadata";
const CREATE_PROJECT_QUEUE = "create-project-queue"
const ADD_FILES_QUEUE = "add-files-queue"

const sqs = new SQSClient({ region: process.env.AWS_REGION_CODE });

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 * 10, // 100MB limit per file
  },
});

export const uploadMiddleware: RequestHandler = upload.array("files", 50); // Allow up to 50 files

export const createProject = asyncHandler(async (req: any, res: Response) => {
  try {
    const { error, value } = createProjectSchema.validate(req.body);
    if (error) throw validationErrorHandler(error);

    const { name, description, tenant_id: tenantId, storage_provider: storageProvider = "b2" } = value;
    let fileLocations =
      typeof value.file_locations === "string"
        ? JSON.parse(value.file_locations as string || "[]")
        : value.file_locations;

    const files = req.files as Express.Multer.File[];

    if ((!files || !files.length) && (!fileLocations || !fileLocations.length)) {
      return res.status(400).json({ error: "No files provided" });
    }

    let tenant: Tenant | undefined = undefined;

    if (tenantId) {
      const { Item } = await client.send(
        new GetItemCommand({
          TableName: "Tenants",
          Key: {
            tenant_id: { S: tenantId },
          },
        })
      );


      if (Item) {
        tenant = unmarshall(Item) as Tenant;
        const isMember = tenant.members?.some(
          member => member.user_id === req.user?.user_id
        );

        if (!isMember) {
          return res.status(403).json({ message: "User not in team" });
        }

      } else {
        throw new Error(`Tenant with ID ${tenantId} not found`);
      }
    }

    // Build initial share URL
    const slug = encodeURIComponent(name.trim().toLowerCase().replace(/\s+/g, "-"));
    const base = `/${req.user.username}`;
    const projectUrl = `${base}/${slug}`;
    let uniqueProjectUrl = projectUrl
    let count = 0;

    while (true) {
      const existingProjectsResponse = await client.send(
        new QueryCommand({
          TableName: PROJECTS_TABLE,
          IndexName: "ProjectUrlIndex",
          KeyConditionExpression: "project_url = :projectUrlPart",
          ExpressionAttributeValues: marshall({ ":projectUrlPart": uniqueProjectUrl }),
        })
      );

      if (!existingProjectsResponse.Items || existingProjectsResponse.Items.length === 0) {
        break; // unique URL found
      }

      count += 1;
      uniqueProjectUrl = `${projectUrl}-${count}`;
    }

    // Prepare job payload
    const projectId = uuidv4();
    const projectName = count > 0 ? `${name}-${count}` : name
    const payload: any = {
      user: {
        user_id: req.user.user_id,
        username: req.user.username,
        dropbox: req.user.dropbox,
      },
      project: {
        project_id: projectId,
        name: projectName,
        description,
      },
      files: files?.length
        ? files.map((f) => ({
          originalname: f.originalname,
          mimetype: f.mimetype,
          buffer: f.buffer.toString("base64"), // serialize buffer
        }))
        : [],
      file_locations: fileLocations || [],
      storage_provider: storageProvider
    };

    if (tenant) payload["tenant"] = {
      tenant: {
        tenant_id: tenantId,
        name: tenant?.name
      }
    }

    // Then use uniqueProjectUrl in projectData
    const projectData: Project = {
      project_id: projectId,
      user_id: req.user.user_id,
      name: projectName,
      description: description || null,
      project_url: uniqueProjectUrl,
      approved_tenant_users: [],
      google_folder_id: "",
      google_shared_link: "",
      dropbox_folder_path: "",
      dropbox_shared_link: "",
      b2_folder_path: "",
      b2_shared_link: "",
      created_at: new Date().toISOString(),
      status: "initiated"
    };

    if (tenantId) projectData["tenant_id"] = tenantId

    await client.send(
      new PutItemCommand({
        TableName: PROJECTS_TABLE,
        Item: marshall(projectData),
      })
    );

    // create({ Records: [{ body: JSON.stringify(payload) }] } as SQSEvent, {} as Context, () => { })

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: `https://sqs.${process.env.AWS_REGION_CODE}.amazonaws.com/${process.env.AWS_ACCOUNT_ID}/${CREATE_PROJECT_QUEUE}`,
        MessageBody: JSON.stringify(payload),
      })
    );

    res.status(202).json({
      ...projectData, project_url: (getHandleUrl(process.env.EXPRESS_PUBLIC_FRONTEND_URL, tenant?.handle)) + projectData.project_url
    });
  } catch (error: any) {
    console.error("Create project error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to fetch projects" });
  }
});

export const getProjects = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const response = await client.send(
        new ScanCommand({
          TableName: PROJECTS_TABLE,
          FilterExpression: "user_id = :userId",
          ExpressionAttributeValues: marshall({
            ":userId": req.user?.user_id,
          }),
        })
      );

      const projects = response.Items?.map((item) => unmarshall(item)) || [];

      res.status(200).json(projects);
    } catch (error: any) {
      console.error("Get projects error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to fetch projects" });
    }
  }
);

export const getTenantProjects = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { tenantId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: "tenant_id parameter is required" });
    }

    try {
      const tenantResponse = await client.send(
        new GetItemCommand({
          TableName: TENANTS_TABLE,
          Key: marshall({ tenant_id: tenantId }),
        })
      );

      if (!tenantResponse.Item) return res.status(404).json({ error: "Tenant not found" });

      const tenant = unmarshall(tenantResponse.Item) as Tenant;

      const response = await client.send(
        new ScanCommand({
          TableName: PROJECTS_TABLE,
          FilterExpression: "tenant_id = :tenantId",
          ExpressionAttributeValues: marshall({
            ":tenantId": tenantId,
          }),
        })
      );

      const member = tenant.members?.find((m) => m.user_id === req.user?.user_id);
      if (!member) return res.status(403).json({ error: "User is not a tenant member" });

      const projects = response.Items?.map((item) => unmarshall(item)) as Project[] || [];

      // Apply filtering based on role
      const visibleProjects = member.role === "admin"
        ? projects // admin sees all
        : projects.filter((project) =>
          project.approved_tenant_users?.map((u) => u.user_id).includes(req.user?.user_id || "")
        );

      res.status(200).json(visibleProjects);
    } catch (error: any) {
      console.error("Get projects error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to fetch projects" });
    }
  }
);

export const getProject = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { projectId } = req.params;

    try {
      const response = await client.send(
        new GetItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id: projectId }),
        })
      );

      if (!response.Item) {
        return res.status(404).json({ error: "Project not found" });
      }

      const project = unmarshall(response.Item);

      let tenant: Tenant | null = null

      if (project.tenant_id) {
        const response = await client.send(
          new GetItemCommand({
            TableName: TENANTS_TABLE,
            Key: marshall({ tenant_id: project.tenant_id }),
          })
        );

        if (!response.Item) return res.status(404).json({ error: "Tenant not found" });

        tenant = unmarshall(response.Item) as Tenant;
      }

      // Ensure user owns the project
      if (project.user_id !== req.user?.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      res.status(200).json({ ...project, share_url: project.share_url && (getHandleUrl(process.env.EXPRESS_PUBLIC_FRONTEND_URL, tenant?.handle)) + project.share_url });
    } catch (error: any) {
      console.error("Get project error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to fetch project" });
    }
  }
);

export const updateProject = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { error, value: { name: initName, ...value } } = updateProjectSchema.validate(req.body);
    if (error) throw validationErrorHandler(error);

    const { projectId } = req.params;

    try {
      // Fetch project first
      const getRes = await client.send(
        new GetItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id: projectId }),
        })
      );

      if (!getRes.Item) {
        return res.status(404).json({ error: "Project not found" });
      }

      const project = unmarshall(getRes.Item) as Project;

      if (project.user_id !== req.user?.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const updateExpr: string[] = [];
      const exprAttrValues: Record<string, any> = {};
      const exprAttrNames: Record<string, string> = {};

      let name = initName
      let newDropboxPath: string | undefined;

      let newProjectUrl = project.project_url;
      let count = 0;

      if (name && name !== project.name) {
        updateExpr.push("#n = :name");
        exprAttrNames["#n"] = "name";
        exprAttrValues[":name"] = name;

        while (true) {
          name = `${name}${!!count ? "-" + count : ""}`;
          newProjectUrl = `/${req.user?.username}/${encodeURI(name
            .toLowerCase()
            .replace(/\s+/g, "-"))
            }`;

          const existingProjectsResponse = await client.send(
            new QueryCommand({
              TableName: PROJECTS_TABLE,
              IndexName: "ProjectUrlIndex",
              KeyConditionExpression: "project_url = :projectUrlPart",
              ExpressionAttributeValues: marshall({ ":projectUrlPart": `${newProjectUrl}${!!count ? "-" + count : ""}` }),
            })
          );

          const existingProjects = existingProjectsResponse.Items;

          if (!existingProjects || existingProjects.length === 0) {
            break; // no collision, unique URL found
          }

          count += 1;
        }

        updateExpr.push("project_url = :project_url");
        exprAttrValues[":project_url"] = newProjectUrl;



        // Move Dropbox folder if it exists
        let newPath: string | undefined;

        if (name !== project.name) {
          if (project.dropbox_folder_path && req.user?.dropbox?.access_token) {
            // Handle Dropbox rename
            const dropboxService = new DropboxService(req.user.dropbox.access_token);

            const currentPath = project.dropbox_folder_path;
            const parentFolder = currentPath.split("/").slice(0, -1).join("/") || "";
            newPath = `${parentFolder}/${name}`;

            const tryMoveFolder = async (targetPath: string) => {
              await dropboxService.moveFolder(currentPath, targetPath);
              updateExpr.push("dropbox_folder_path = :dropbox_folder_path");
              exprAttrValues[":dropbox_folder_path"] = targetPath;
            };

            try {
              await tryMoveFolder(newPath);
            } catch (err: any) {
              const isUnauthorized = err.status === 401;

              if (isUnauthorized && req.user.dropbox.refresh_token) {
                try {
                  await dropboxService.refreshDropboxToken(req.user);
                  await tryMoveFolder(newPath);
                } catch (refreshError) {
                  console.error("Dropbox token refresh failed", refreshError);
                  return res.status(500).json({ error: "Failed to refresh Dropbox token" });
                }
              } else {
                console.error("Dropbox folder move failed", err);
                return res.status(500).json({ error: "Failed to move Dropbox folder" });
              }
            }
            // } else if (project.google_folder_id && req.user?.google?.access_token) {
            //   // Handle Dropbox rename
            //   const googleDriveService = new GoogleDriveService(req.user.google.access_token);

            //   const currentId = project.google_folder_id;
            //   newPath = `${name}`;


            //   const tryMoveFolder = async (targetPath: string) => {
            //     const { destinationFolderId } = await googleDriveService.moveFolder(currentId, targetPath);
            //     updateExpr.push("google_folder_id = :google_folder_id");
            //     exprAttrValues[":google_folder_id"] = destinationFolderId;
            //   };

            //   try {
            //     await tryMoveFolder(newPath);
            //   } catch (err: any) {
            //     const isUnauthorized = err.status === 401;

            //     if (isUnauthorized && req.user.google.refresh_token) {
            //       try {
            //         await googleDriveService.refreshGoogleToken(req.user);
            //         await tryMoveFolder(newPath);
            //       } catch (refreshError) {
            //         console.error("Google token refresh failed", refreshError);
            //         return res.status(500).json({ error: "Failed to refresh Google token" });
            //       }
            //     } else {
            //       console.error("Google Drive folder move failed", err);
            //       return res.status(500).json({ error: "Failed to move Google Drive folder" });
            //     }
            //   }
          } else if (project.b2_folder_path) {
            const b2Service = new BackblazeService(B2_BUCKET_ID, req.user?.user_id!, project.tenant_id);

            const currentPath = project.b2_folder_path;
            const parentFolder = currentPath
              .split("/")
              .slice(0, -1)
              .join("/");

            const newPath = parentFolder
              ? `${parentFolder}/${name}`
              : name;

            try {
              // Move folder in Backblaze
              await b2Service.moveFolder(currentPath, newPath);

              await moveFolder(s3Client, THUMBNAILS_BUCKET, currentPath, newPath)

              // Update DynamoDB expression
              updateExpr.push("b2_folder_path = :b2_folder_path");
              exprAttrValues[":b2_folder_path"] = newPath;
            } catch (err) {
              console.error("Backblaze folder rename failed", err);
              return res.status(500).json({ error: "Failed to rename Backblaze folder" });
            }
          }
        }
      }

      if (value.description !== undefined) {
        updateExpr.push("description = :description");
        exprAttrValues[":description"] = value.description;
      }

      if (value.approved_tenant_users !== undefined) {
        updateExpr.push("approved_tenant_users = :approved_tenant_users");
        exprAttrValues[":approved_tenant_users"] = value.approved_tenant_users;
      }

      if (value.approved_tenant_users) {
        const self = (value.approved_tenant_users as Project["approved_tenant_users"]).find(
          (u) => u.user_id === req.user?.user_id
        );

        if (self) return res.status(400).json({ error: "You cannot edit or add yourself" });
      }

      // Add updated_at timestamp
      updateExpr.push("updated_at = :updated_at");
      exprAttrValues[":updated_at"] = new Date().toISOString();

      await client.send(
        new UpdateItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id: projectId }),
          UpdateExpression: `SET ${updateExpr.join(", ")}`,
          ExpressionAttributeNames: Object.keys(exprAttrNames).length
            ? exprAttrNames
            : undefined,
          ExpressionAttributeValues: marshall(exprAttrValues, { removeUndefinedValues: true }),
        })
      );

      let tenant: Tenant | null = null

      if (project.tenant_id) {
        const response = await client.send(
          new GetItemCommand({
            TableName: TENANTS_TABLE,
            Key: marshall({ tenant_id: project.tenant_id }),
          })
        );

        if (!response.Item) return res.status(404).json({ error: "Tenant not found" });

        tenant = unmarshall(response.Item) as Tenant;
      }

      const FieldLabels: Record<string, string> = {
        name: "Name",
        description: "Description",
        is_public: "Visibility",
        can_download: "Download Permission",
        approved_emails: "Approved Emails",
        approved_tenant_users: "Approved Tenant Users",
        dropbox_folder_path: "Dropbox Folder",
        b2_folder_path: "Backblaze Folder",
      };

      const updatedFields = updateExpr
        .map((expr) => {
          const rawField = expr.split("=").shift()?.trim();
          if (!rawField || rawField === "updated_at") return null;

          const field = rawField.startsWith("#")
            ? exprAttrNames[rawField]
            : rawField;

          return field ? FieldLabels[field] : null;
        })
        .filter(Boolean) as string[];

      await createProjectHistoryItem<ProjectHistoryType.PROJECT_UPDATED>({
        project_id: projectId,
        actor_id: req.user?.user_id,
        type: ProjectHistoryType.PROJECT_UPDATED,
        context: {
          fields: updatedFields,
        },
      });

      res.status(200).json({
        message: "Project updated successfully",
        ...(newProjectUrl !== project.project_url ? { project_url: (getHandleUrl(process.env.EXPRESS_PUBLIC_FRONTEND_URL, tenant?.handle)) + newProjectUrl } : {}),
        ...(newDropboxPath !== project.dropbox_folder_path ? { dropbox_folder_path: newDropboxPath } : {}),
      });
    } catch (error: any) {
      console.error("Update project error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to update project" });
    }
  }
);

export const deleteProject = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { projectId } = req.params;

    try {
      const getRes = await client.send(
        new GetItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id: projectId }),
        })
      );

      if (!getRes.Item) {
        return res.status(404).json({ error: "Project not found" });
      }

      const project = unmarshall(getRes.Item);

      if (project.user_id !== req.user?.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      if (project.dropbox_folder_path && req.user?.dropbox?.access_token) {
        const dropboxService = new DropboxService(req.user.dropbox.access_token);
        try {
          await dropboxService.deleteFolder(project.dropbox_folder_path);
        } catch (err) {
          await dropboxService.refreshDropboxToken(req.user)
          await dropboxService.deleteFolder(project.dropbox_folder_path);
          console.warn("Failed to delete Dropbox folder:", err);
        }
      } else if (project.b2_folder_path && req.user?.user_id) {
        const b2Service = new BackblazeService(B2_BUCKET_ID, req.user.user_id, project.tenant_id);

        try {
          await b2Service.deleteFolder(project.b2_folder_path);
        } catch (err) {
          console.error("Failed to delete Backblaze folder:", err);
          return res.status(500).json({ error: "Failed to delete Backblaze folder" });
        }
      }


      await client.send(
        new DeleteItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id: projectId }),
        })
      );

      await createProjectHistoryItem<ProjectHistoryType.PROJECT_DELETED>({
        project_id: projectId,
        actor_id: req.user?.user_id,
        type: ProjectHistoryType.PROJECT_DELETED,
      });

      res.status(200).json({ message: "Project deleted successfully" });
    } catch (error: any) {
      console.error("Delete project error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to delete project" });
    }
  }
);

export const getProjectByShareId = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const authHeader = req.headers.authorization;

      if (authHeader) {
        const user = await getUserFromToken(authHeader.substring(7));
        req.user = user;
      }
      const { handle, mode, shareId } = req.params;
      const emailParam = (req.query.email as string | undefined)?.toLowerCase();

      if (mode !== "s" && mode !== "p") {
        return res.status(400).json({ error: "INVALID_SHARE_TYPE" });
      }

      const m = mode === "s" ? "collaborative" : "presentation";

      /* =========================
         Get Share by ID + Mode
      ========================= */

      const shareResult = await client.send(
        new GetItemCommand({
          TableName: SHARES_TABLE,
          Key: marshall({
            share_id: shareId,
          }),
        })
      );

      if (!shareResult.Item) {
        return res.status(404).json({ error: "Share not found" });
      }

      const share = unmarshall(shareResult.Item) as Share;

      /* =========================
         2️⃣ Validate Access
      ========================== */

      const isOwner = req.user?.user_id === share.user_id;

      if (!share.is_public && !isOwner) {
        if (!emailParam) {
          return res.status(400).json({ error: "EMAIL_REQUIRED" });
        }

        const approvedEmails = (share.approved_emails || []).map((e) =>
          e.value.toLowerCase()
        );

        if (!approvedEmails.includes(emailParam)) {
          return res.status(403).json({ error: "EMAIL_INVALID" });
        }
      }

      let hasAccess = isOwner || share.is_public;

      // 1️⃣ Check logged-in user
      if (!hasAccess && req.user) {
        const approvedUserIds = (share.approved_users || []).map(u => u.user_id);
        hasAccess = approvedUserIds.includes(req.user.user_id);
      }

      // 2️⃣ Check email param for non-logged-in users
      if (!hasAccess && emailParam) {
        const approvedEmails = (share.approved_emails || []).map(e => e.value.toLowerCase());
        hasAccess = approvedEmails.includes(emailParam);
      }

      // 3️⃣ Deny if still no access
      if (!hasAccess) {
        return res.status(403).json({ error: "Acces Denied" });
      }

      /* =========================
         3️⃣ Get Project
      ========================== */

      const projectResult = await client.send(
        new GetItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({
            project_id: share.project_id,
          }),
        })
      );

      if (!projectResult.Item) {
        return res.status(404).json({ error: "Project not found" });
      }

      const project = unmarshall(projectResult.Item) as Project;

      /* =========================
         4️⃣ Apply Share Mode Rules
      ========================== */



      const projectWithMedia = await getProjectWithMedia(project, handle);

      const clearProject: Partial<Project> = {
        project_id: project.project_id,
        user_id: project.user_id,
        name: project.name,
        description: project.description,
        google_folder_id: project.google_folder_id,
        dropbox_folder_path: project.dropbox_folder_path,
        b2_folder_path: project.b2_folder_path,
        created_at: project.created_at,
        updated_at: project.updated_at,
      };

      const cleanShare: Partial<Share> = {
        share_id: share.share_id,
        project_id: share.project_id,
        user_id: share.user_id,
        name: share.name,
        mode: share.mode,
        share_url: share.share_url,
        expires_at: share.expires_at,
        can_note: share.can_note,
        can_rate: share.can_rate,
        can_upload: share.can_upload,
        is_public: share.is_public,
        can_download: share.can_download,
        created_at: share.created_at,
      };

      const canEdit = share.mode === "collaborative" &&
        share?.approved_users?.some(
          (u) =>
            u.user_id === req.user?.user_id &&
            u.role === "editor"
        ) ||
        project?.approved_tenant_users?.some(
          (u) =>
            u.user_id === req.user?.user_id &&
            (u.role === "admin" || u.role === "editor")
        );

      const isAdmin = project?.approved_tenant_users?.some(
        (u) =>
          u.user_id === req.user?.user_id &&
          (u.role === "admin")
      ) || project.user_id === req.user?.user_id;

      res.status(200).json({
        project: clearProject,
        media: projectWithMedia?.media,
        share: cleanShare,
        permissions: {
          is_admin: isAdmin,
          can_note: canEdit && share.can_note,
          can_rate: canEdit && share.can_rate,
          can_upload: canEdit && share.can_upload,
          can_download: canEdit && share.can_download,
        }
      });

    } catch (error: any) {
      console.error("Get project by share ID error:", error);
      res.status(500).json({
        error: error.message || "Failed to fetch project",
      });
    }
  }
);


export const getProjectByProjectUrl = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const authHeader = req.headers.authorization;

      if (authHeader)
        await getUserFromToken(authHeader.substring(7)).then((user) => req.user = user)

      const { username, projectName } = req.params;

      const response = await client.send(
        new QueryCommand({
          TableName: PROJECTS_TABLE,
          IndexName: "ProjectUrlIndex",
          KeyConditionExpression: "project_url = :projectUrlPart",
          ExpressionAttributeValues: marshall({
            ":projectUrlPart": `/${username}/${encodeURIComponent(projectName)}`,
          }),
        })
      );

      if (!response.Items || response.Items.length === 0) {
        console.log(projectName)
        return res.status(404).json({ error: "Project not found" });
      }

      const project = unmarshall(response.Items[0]) as Project;


      // Handle private project email validation
      if (req.user?.username !== username) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const projectWithMedia = await getProjectWithMedia(project, username)

      const canEdit =
        project?.approved_tenant_users?.some(
          (u) =>
            u.user_id === req.user?.user_id &&
            (u.role === "admin" || u.role === "editor")
        );

      const isAdmin = project?.approved_tenant_users?.some(
        (u) =>
          u.user_id === req.user?.user_id &&
          (u.role === "admin")
      ) || project.user_id === req.user?.user_id;

      return res.status(200).json({
        ...projectWithMedia,
        permissions: {
          is_admin: isAdmin,
          can_note: canEdit,
          can_rate: canEdit,
          can_upload: canEdit,
          can_download: canEdit,
        }
      });
    } catch (error: any) {
      console.error("Get project by project URL error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to fetch project" });
    }
  }
);

/**
 * Fetch a public or authorized tenant project by project URL
 */
export const getTenantProjectByProjectUrl = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tenantHandle, username, projectName } = req.params;

      const projectUrl = `${username}/${encodeURIComponent(projectName)}`;

      const tenantResponse = await client.send(
        new GetItemCommand({
          TableName: TENANTS_TABLE,
          Key: marshall({
            handle: tenantHandle,
          }),
        })
      );

      if (!tenantResponse.Item) {
        return res.status(404).json({ error: "TENANT_NOT_FOUND" });
      }

      const tenant = unmarshall(tenantResponse.Item) as Tenant;

      const projectResponse = await client.send(
        new QueryCommand({
          TableName: PROJECTS_TABLE,
          IndexName: "TenantProjectIndex",
          KeyConditionExpression: "tenant_id = :tenantId AND project_url = :projectUrl",
          ExpressionAttributeValues: marshall({
            ":tenantId": tenant.tenant_id,
            ":projectUrl": projectUrl,
          }),
          Limit: 1,
        })
      );

      if (!projectResponse.Items || projectResponse.Items.length === 0) {
        return res.status(404).json({ error: "PROJECT_NOT_FOUND" });
      }

      const project = unmarshall(projectResponse.Items[0]) as Project;


      /* =========================
         3️⃣ Authorization
      ========================== */

      const userId = req.user?.user_id;

      if (!userId) {
        return res.status(401).json({ error: "UNAUTHORIZED" });
      }

      const isMember = tenant.members?.some(
        (member) => member.user_id === userId
      );

      if (!isMember) {
        return res.status(403).json({ error: "USER_NOT_IN_TENANT" });
      }

      /* =========================
         4️⃣ Return Project
      ========================== */

      const projectWithMedia = await getProjectWithMedia(
        project,
        tenantHandle
      );

      const canEdit =
        project?.approved_tenant_users?.some(
          (u) =>
            u.user_id === req.user?.user_id &&
            (u.role === "admin" || u.role === "editor")
        );

      const isAdmin = project?.approved_tenant_users?.some(
        (u) =>
          u.user_id === req.user?.user_id &&
          (u.role === "admin")
      ) || project.user_id === req.user?.user_id;

      return res.status(200).json({
        ...projectWithMedia,
        permissions: {
          is_admin: isAdmin,
          can_note: canEdit,
          can_rate: canEdit,
          can_upload: canEdit,
          can_download: canEdit,
        }
      });

    } catch (error: any) {
      console.error("Get tenant project by project URL error:", error);

      return res.status(500).json({
        error: error.message || "FAILED_TO_FETCH_PROJECT",
      });
    }
  }
);

export const addProjectFiles = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { projectId } = req.params;
    const { tenant_id: tenantId } = req.body;

    let tenant: Tenant | undefined = undefined;

    if (tenantId) {
      const { Item } = await client.send(
        new GetItemCommand({
          TableName: "Tenants",
          Key: {
            tenant_id: { S: tenantId },
          },
        })
      );


      if (Item) {
        tenant = unmarshall(Item) as Tenant;
        const isMember = tenant.members?.some(
          member => member.user_id === req.user?.user_id
        );

        if (!isMember) {
          return res.status(403).json({ message: "User not in team" });
        }

      } else {
        throw new Error(`Tenant with ID ${tenantId} not found`);
      }
    }

    let fileLocations =
      typeof req.body.file_locations === "string"
        ? JSON.parse(req.body.file_locations as string || "[]")
        : req.body.file_locations;


    const files = req.files as Express.Multer.File[];

    if ((!fileLocations || !fileLocations?.length) && !files) {
      return res.status(400).json({ error: "No files provided" });
    }

    try {
      // Fetch project
      const getRes = await client.send(
        new GetItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id: projectId }),
        })
      );

      if (!getRes.Item) {
        return res.status(404).json({ error: "Project not found" });
      }

      const project = unmarshall(getRes.Item);

      if (!req.user || project.user_id !== req.user?.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      if (project.dropbox_folder_path && !req.user?.dropbox?.access_token) {
        return res.status(400).json({ error: "Dropbox access token missing" });
      }

      if (project.google_folder_id && !req.user?.google?.access_token) {
        return res.status(400).json({ error: "Google access token missing" });
      }

      // add({
      //   Records: [{
      //     body:
      //       JSON.stringify({
      //         projectId,
      //         user: { user_id: req.user.user_id, dropbox: req.user.dropbox, google: req.user.google },
      //         tenant: { tenant_id: tenant?.tenant_id, name: tenant?.name },
      //         files: fileLocations,
      //       }),
      //   }]
      // } as SQSEvent, {} as Context, () => { })      // Enqueue job for SQS worker to handle Dropbox upload

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: `https://sqs.${process.env.AWS_REGION_CODE}.amazonaws.com/${process.env.AWS_ACCOUNT_ID}/${ADD_FILES_QUEUE}`,
          MessageBody: JSON.stringify({
            projectId,
            user: { user_id: req.user.user_id, dropbox: req.user.dropbox, google: req.user.google },
            tenant: { tenant_id: tenant?.tenant_id, name: tenant?.name },
            files: fileLocations,
          }),
        })
      );

      res.status(202).json({
        message: "Files queued for upload",
        files: fileLocations,
      });
    } catch (error: any) {
      console.error("Add project files error:", error);
      res.status(500).json({ error: error.message || "Failed to add files" });
    }
  }
);

export const removeProjectFile = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { projectId, fileName } = req.params;

    try {
      // Fetch project
      const getRes = await client.send(
        new GetItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id: projectId }),
        })
      );

      if (!getRes.Item) {
        return res.status(404).json({ error: "Project not found" });
      }

      const project = unmarshall(getRes.Item);

      if (project.user_id !== req.user?.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      if (!req.user?.dropbox?.access_token) {
        return res.status(400).json({ error: "Dropbox access token missing" });
      }

      if (project.dropbox_folder_path && req.user?.dropbox?.access_token) {
        const dropboxService = new DropboxService(req.user.dropbox.access_token);

        try {
          await dropboxService.deleteFile(project.dropbox_folder_path, fileName);

          const { project_id, media_name } = req.params;

          if (!project_id || !media_name) {
            return res.status(400).json({
              error: "project_id and media_name are required",
            });
          }

          await client.send(
            new DeleteItemCommand({
              TableName: METADATA_TABLE,
              Key: marshall({ project_id, media_name }),
            })
          );

        } catch (err: any) {
          console.error("Dropbox file delete failed", err);
          return res.status(500).json({ error: "Failed to delete file" });
        }
        // } else if (project.dropbox_folder_path && req.user?.dropbox?.access_token) {
        //   const googleDriveService = new GoogleDriveService(req.user.dropbox.access_token);

        //   try {
        //     await googleDriveService.deleteFile(project.google_folder_id, fileName);

        //     const { project_id, media_name } = req.params;

        //     if (!project_id || !media_name) {
        //       return res.status(400).json({
        //         error: "project_id and media_name are required",
        //       });
        //     }

        //     await client.send(
        //       new DeleteItemCommand({
        //         TableName: METADATA_TABLE,
        //         Key: marshall({ project_id, media_name }),
        //       })
        //     );
        //   } catch (err: any) {
        //     console.error("Dropbox file delete failed", err);
        //     return res.status(500).json({ error: "Failed to delete file" });
        //   }
      } else if (project.b2_folder_path && req.user?.user_id) {
        const b2Service = new BackblazeService(B2_BUCKET_ID, req.user.user_id, project.tenant_id);

        try {
          await b2Service.deleteFile(project.b2_folder_path, fileName);
        } catch (err: any) {
          console.error("Backblaze file delete failed", err);
          return res.status(500).json({ error: "Failed to delete file" });
        }
      }

      await createProjectHistoryItem<ProjectHistoryType.FILE_REMOVED>({
        project_id: projectId,
        actor_id: req.user?.user_id,
        type: ProjectHistoryType.FILE_REMOVED,
        context: {
          fileName: fileName,
        },
      });

      res.status(200).json({ message: "File removed successfully" });
    } catch (error: any) {
      console.error("Remove project file error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to remove file" });
    }
  }
);
