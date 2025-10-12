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
import { CreateProjectInput, UpdateProjectInput, Project, S3Location, User } from "../types";
import { v4 as uuidv4 } from "uuid";
import { DropboxService } from "../utils/dropbox";
import { AuthenticatedRequest, getUserFromToken } from "../middleware/auth";
import { Request, RequestHandler, Response } from "express";
import multer from "multer";
import { deleteItemImage, getItemFile, getSignedImage, s3ObjectExists, saveItemImage } from "../utils/s3";
import { S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });

const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || "Projects";
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";
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

    const { name, description } = value;
    let fileLocations =
      typeof value.file_locations === "string"
        ? JSON.parse(value.file_locations as string || "[]")
        : value.file_locations;

    const files = req.files as Express.Multer.File[];

    if ((!files || !files.length) && (!fileLocations || !fileLocations.length)) {
      return res.status(400).json({ error: "No files provided" });
    }

    if (!req.user?.dropbox?.access_token) {
      return res.status(400).json({
        error: "Dropbox access token not found. Please connect your Dropbox account.",
      });
    }

    // Prepare job payload
    const projectId = uuidv4();

    const payload = {
      project_id: projectId,
      user: {
        user_id: req.user.user_id,
        username: req.user.username,
        dropbox: req.user.dropbox,
      },
      project: {
        name,
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
    };

    // Build initial share URL
    let shareUrl = `/${req.user.username}/${encodeURI(name.toLowerCase().replace(/\s+/g, "-"))}`;
    let uniqueShareUrl = shareUrl;
    let count = 0;

    while (true) {
      const existingProjectsResponse = await client.send(
        new QueryCommand({
          TableName: PROJECTS_TABLE,
          IndexName: "ShareUrlIndex",
          KeyConditionExpression: "share_url = :shareUrlPart",
          ExpressionAttributeValues: marshall({ ":shareUrlPart": uniqueShareUrl }),
        })
      );

      if (!existingProjectsResponse.Items || existingProjectsResponse.Items.length === 0) {
        break; // unique URL found
      }

      count += 1;
      uniqueShareUrl = `${shareUrl}-${count}`;
    }

    // Then use uniqueShareUrl in projectData
    const projectData = {
      project_id: projectId,
      user_id: req.user.user_id,
      name: count > 0 ? `${name}-${count}` : name,
      description: description || null,
      share_url: uniqueShareUrl,
      is_public: false,
      can_download: false,
      approved_emails: [],
      dropbox_folder_path: "",
      dropbox_shared_link: "",
      created_at: new Date().toISOString(),
      status: "initiated"
    };

    await client.send(
      new PutItemCommand({
        TableName: PROJECTS_TABLE,
        Item: marshall(projectData),
      })
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: `https://sqs.${process.env.AWS_REGION_CODE}.amazonaws.com/${process.env.AWS_ACCOUNT_ID}/${CREATE_PROJECT_QUEUE}`,
        MessageBody: JSON.stringify(payload),
      })
    );

    res.status(202).json({
      ...projectData, share_url: process.env.EXPRESS_PUBLIC_FRONTEND_URL + projectData.share_url
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

      // Ensure user owns the project
      if (project.user_id !== req.user?.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      res.status(200).json({ ...project, share_url: project.share_url && process.env.EXPRESS_PUBLIC_FRONTEND_URL + project.share_url });
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

      const project = unmarshall(getRes.Item);

      if (project.user_id !== req.user?.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const updateExpr: string[] = [];
      const exprAttrValues: Record<string, any> = {};
      const exprAttrNames: Record<string, string> = {};

      let name = initName
      let newDropboxPath: string | undefined;

      let newShareUrl = project.share_url;
      let count = 0;

      if (name && name !== project.name) {
        updateExpr.push("#n = :name");
        exprAttrNames["#n"] = "name";
        exprAttrValues[":name"] = name;

        while (true) {
          name = `${name}${!!count ? "-" + count : ""}`;
          newShareUrl = `/${req.user?.username}/${encodeURI(name
            .toLowerCase()
            .replace(/\s+/g, "-"))
            }`;

          const existingProjectsResponse = await client.send(
            new QueryCommand({
              TableName: PROJECTS_TABLE,
              IndexName: "ShareUrlIndex",
              KeyConditionExpression: "share_url = :shareUrlPart",
              ExpressionAttributeValues: marshall({ ":shareUrlPart": `${newShareUrl}${!!count ? "-" + count : ""}` }),
            })
          );

          const existingProjects = existingProjectsResponse.Items;

          if (!existingProjects || existingProjects.length === 0) {
            break; // no collision, unique URL found
          }

          count += 1;
        }

        updateExpr.push("share_url = :share_url");
        exprAttrValues[":share_url"] = newShareUrl;



        // Move Dropbox folder if it exists
        if (project.dropbox_folder_path && req.user?.dropbox?.access_token && name !== project.name) {
          const dropboxService = new DropboxService(req.user.dropbox.access_token);

          const currentPath = project.dropbox_folder_path;
          const parentFolder = currentPath.split("/").slice(0, -1).join("/") || "";
          newDropboxPath = `${parentFolder}/${name}`;

          const tryMoveFolder = async (targetPath: string) => {
            await dropboxService.moveFolder(currentPath, targetPath);
            updateExpr.push("dropbox_folder_path = :dropbox_folder_path");
            exprAttrValues[":dropbox_folder_path"] = targetPath;
          };

          try {
            await tryMoveFolder(newDropboxPath);
          } catch (err: any) {
            const isUnauthorized = err.status === 401;

            // If token expired and refresh token available
            if (isUnauthorized && req.user.dropbox.refresh_token) {
              try {
                await dropboxService.refreshDropboxToken(req.user);
                await tryMoveFolder(newDropboxPath);
              } catch (refreshError) {
                console.error("Dropbox token refresh failed", refreshError);
                return res.status(500).json({ error: "Failed to refresh Dropbox token" });
              }
            } else {
              console.error("Dropbox folder move failed", err);
              return res.status(500).json({ error: "Failed to move Dropbox folder" });
            }
          }
        }
      }

      if (value.description !== undefined) {
        updateExpr.push("description = :description");
        exprAttrValues[":description"] = value.description;
      }

      if (value.is_public !== undefined) {
        updateExpr.push("is_public = :is_public");
        exprAttrValues[":is_public"] = value.is_public;
      }

      if (value.can_download !== undefined) {
        updateExpr.push("can_download = :can_download");
        exprAttrValues[":can_download"] = value.can_download;
      }

      if (value.approved_emails?.length) {
        updateExpr.push("approved_emails = :approved_emails");
        exprAttrValues[":approved_emails"] = value.approved_emails;
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

      res.status(200).json({
        message: "Project updated successfully",
        ...(newShareUrl !== project.share_url ? { share_url: process.env.EXPRESS_PUBLIC_FRONTEND_URL + newShareUrl } : {}),
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
      }

      await client.send(
        new DeleteItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id: projectId }),
        })
      );

      res.status(200).json({ message: "Project deleted successfully" });
    } catch (error: any) {
      console.error("Delete project error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to delete project" });
    }
  }
);

export const getProjectByShareUrl = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const authHeader = req.headers.authorization;

      if (authHeader)
        await getUserFromToken(authHeader.substring(7)).then((user) => req.user = user)

      const { username, projectName } = req.params;
      const emailParam = (req.query.email as string | undefined)?.toLowerCase();

      const response = await client.send(
        new QueryCommand({
          TableName: PROJECTS_TABLE,
          IndexName: "ShareUrlIndex", // 👈 use the GSI
          KeyConditionExpression: "share_url = :shareUrlPart",
          ExpressionAttributeValues: marshall({
            ":shareUrlPart": `/${username}/${(projectName)}`,
          }),
        })
      );

      if (!response.Items || response.Items.length === 0) {
        return res.status(404).json({ error: "Project not found" });
      }

      const project = unmarshall(response.Items[0]) as Project;
      const isPublic = project.is_public === true;
      const approvedEmails = (project.approved_emails || []).map((e: string) =>
        e.toLowerCase()
      );

      // Handle private project email validation
      if (!isPublic && req.user?.username !== username) {
        if (!emailParam) {
          return res.status(400).json({ error: "EMAIL_REQUIRED" });
        }

        if (!approvedEmails.includes(emailParam)) {
          return res.status(403).json({ error: "EMAIL_INVALID" });
        }
      }

      const publicProject: Partial<Project> = {
        project_id: project.project_id,
        user_id: project.user_id,
        name: project.name,
        description: project.description,
        share_url: project.share_url,
        dropbox_shared_link: project.dropbox_shared_link,
        can_download: project.can_download,
        created_at: project.created_at,
        updated_at: project.updated_at,
      };

      if (req.user?.user_id === project.user_id) {
        publicProject.approved_emails = project.approved_emails
        publicProject.is_public = project.is_public
      }

      const userResponse = await client.send(
        new GetItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: project.user_id }),
        })
      );

      if (!userResponse.Item) {
        return res.status(404).json({ error: "User not found" });
      }

      let user = unmarshall(userResponse.Item);


      if (
        !user.dropbox ||
        (!user.dropbox.access_token && !user.dropbox.refresh_token)
      ) {
        return res.status(400).json({ error: "User Dropbox tokens missing." });
      }

      if (
        !project.dropbox_folder_path
      ) {
        return res.status(409).json({ error: "Dropbox folder path missing." });
      }

      let dropboxAccessToken = user.dropbox.access_token;

      const dropboxService = new DropboxService(dropboxAccessToken);

      let dropboxFiles;

      const resolveFiles = async (files: any[]) =>
        Promise.all(
          files.map(async (file) => {
            const s3Key = `thumbnails/${username}/${projectName}/${file.name}`;
            const bucketName = process.env.EXPRESS_S3_TEMP_BUCKET!;

            const exists = await s3ObjectExists(s3Client, bucketName, s3Key);
            const s3Location = exists
              ? { bucket: bucketName, key: s3Key }
              : await saveItemImage(
                s3Client,
                bucketName,
                s3Key,
                file.thumbnail,
                false
              );

            const thumbnailUrl = (await getSignedImage(
              s3Client,
              s3Location
            )) as string;

            delete file.thumbnail; // prevent Lambda 413

            return { ...file, thumbnail_url: thumbnailUrl };
          })
        );

      try {
        dropboxFiles = await dropboxService.listFiles(project.dropbox_folder_path);
        dropboxFiles = await resolveFiles(dropboxFiles);
      } catch (err: any) {
        const isUnauthorized = err.status === 401;

        if (isUnauthorized && user.dropbox.refresh_token) {
          try {
            await dropboxService.refreshDropboxToken(user as User);
            dropboxFiles = await dropboxService.listFiles(
              project.dropbox_folder_path
            );
            dropboxFiles = await resolveFiles(dropboxFiles);
          } catch (refreshError) {
            console.error("Dropbox token refresh failed", refreshError);
            throw refreshError;
          }
        } else {
          console.error("Dropbox access failed", err);
          return res
            .status(500)
            .json({ error: "Failed to access Dropbox files" });
        }
      }

      const images = dropboxFiles.filter((file: any) =>
        /\.(jpg|jpeg|png|gif|webp)$/i.test(file.name)
      );

      res.status(200).json({ project: { ...publicProject, share_url: (process.env.EXPRESS_PUBLIC_FRONTEND_URL || "") + publicProject.share_url }, images });
    } catch (error: any) {
      console.error("Get project by share URL error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to fetch project" });
    }
  }
);

export const addProjectFiles = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { projectId } = req.params;

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

      if (project.user_id !== req.user?.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      if (!req.user?.dropbox?.access_token) {
        return res.status(400).json({ error: "Dropbox access token missing" });
      }

      // Enqueue job for SQS worker to handle Dropbox upload
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: `https://sqs.${process.env.AWS_REGION_CODE}.amazonaws.com/${process.env.AWS_ACCOUNT_ID}/${ADD_FILES_QUEUE}`,
          MessageBody: JSON.stringify({
            projectId,
            user: { user_id: req.user.user_id, dropbox: req.user.dropbox },
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

      const dropboxService = new DropboxService(req.user.dropbox.access_token);

      try {
        await dropboxService.deleteFile(project.dropbox_folder_path, fileName);
      } catch (err: any) {
        console.error("Dropbox file delete failed", err);
        return res.status(500).json({ error: "Failed to delete file" });
      }

      res.status(200).json({ message: "File removed successfully" });
    } catch (error: any) {
      console.error("Remove project file error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to remove file" });
    }
  }
);
