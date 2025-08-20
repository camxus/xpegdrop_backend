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
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  createProjectSchema,
  updateProjectSchema,
} from "../utils/validation/projectValidation";
import axios from "axios";
import { CreateProjectInput, UpdateProjectInput, Project, S3Location } from "../types";
import { v4 as uuidv4 } from "uuid";
import { DropboxService } from "../utils/dropbox";
import { AuthenticatedRequest } from "../middleware/auth";
import { Request, RequestHandler, Response } from "express";
import multer from "multer";
import { deleteItemImage, getItemFile } from "../utils/s3";
import { S3Client } from "@aws-sdk/client-s3";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });
const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || "Projects";
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 * 10, // 100MB limit per file
  },
});

export const uploadMiddleware: RequestHandler = upload.array("files", 50); // Allow up to 50 files

export const createProject = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { error, value } = createProjectSchema.validate(req.body);
    if (error) throw validationErrorHandler(error);

    const { name, description } = value as CreateProjectInput;

    let fileLocations = typeof value.file_locations === "string" ? JSON.parse(value.file_locations as string || "[]") : value.file_locations

    const files = req.files as Express.Multer.File[];

    if (!files || !files.length && !fileLocations || !fileLocations.length) {
      return res.status(400).json({ error: "No files provided" });
    }

    if (!req.user?.dropbox.access_token) {
      return res.status(400).json({
        error:
          "Dropbox access token not found. Please connect your Dropbox account.",
      });
    }

    try {
      const projectId = uuidv4();
      const userId = req.user.user_id;
      const username = req.user.username;

      // Upload folder to Dropbox
      const dropboxService = new DropboxService(
        req.user.dropbox?.access_token!
      );

      // Convert multer files to File objects for Dropbox upload
      const getFiles = async (): Promise<File[]> => {
        if (files.length) {
          // Already in memory
          return files.map((file) => {
            const blob = new Blob([file.buffer], { type: file.mimetype });
            return new File([blob], file.originalname, { type: file.mimetype });
          });
        }

        if (fileLocations.length) {
          // Fetch from S3 in parallel
          return await Promise.all(
            fileLocations.map(async (location: S3Location) => {
              const file = await getItemFile(s3Client, location);
              await deleteItemImage(s3Client, location)
              return file.file; // file is already a File object
            })
          );
        }

        return []; // No files
      };

      const dropboxFiles = await getFiles()
      try {
        if (await dropboxService.folderExists(name)) {
          return res.status(400).json({
            error: `A Dropbox folder named "${name}" already exists. Please choose another name.`,
          });
        }
      } catch (err: any) {
        if (err?.status === 401 && req.user.dropbox.refresh_token) {
          await dropboxService.refreshDropboxToken(req.user);
          await dropboxService.folderExists(name);
        } else {
          throw err;
        }
      }

      const dropboxSharedLink = await dropboxService.uploadFolder(
        dropboxFiles,
        name
      );

      // Generate share URL
      const shareUrl = `${process.env.EXPRESS_PUBLIC_FRONTEND_URL}/${username}/${name
        .toLowerCase()
        .replace(/\s+/g, "-")}`;

      // Save project to DynamoDB
      const projectData: Project = {
        project_id: projectId,
        user_id: userId,
        name,
        description: description || null,
        share_url: shareUrl,
        is_public: true,
        approved_emails: [],
        dropbox_folder_path: `/${name}`,
        dropbox_shared_link: dropboxSharedLink,
        created_at: new Date().toISOString(),
      };

      await client.send(
        new PutItemCommand({
          TableName: PROJECTS_TABLE,
          Item: marshall(projectData),
        })
      );

      res.status(201).json(projectData);
    } catch (error: any) {
      console.error("Create project error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to create project" });
    }
  }
);

export const getProjects = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const response = await client.send(
        new ScanCommand({
          TableName: PROJECTS_TABLE,
          FilterExpression: "user_id = :userId",
          ExpressionAttributeValues: marshall({
            ":userId": req.user.user_id,
          }),
        })
      );

      const projects = response.Items?.map((item) => unmarshall(item)) || [];

      res.status(200).json({
        projects,
        total: projects.length,
      });
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
      if (project.user_id !== req.user.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      res.status(200).json({ project });
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
    const { error, value } = updateProjectSchema.validate(req.body);
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

      if (project.user_id !== req.user.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const updateExpr: string[] = [];
      const exprAttrValues: Record<string, any> = {};
      const exprAttrNames: Record<string, string> = {};

      if (value.name) {
        updateExpr.push("#n = :name");
        exprAttrNames["#n"] = "name";
        exprAttrValues[":name"] = value.name;
      }

      if (value.description !== undefined) {
        updateExpr.push("description = :description");
        exprAttrValues[":description"] = value.description;
      }

      if (value.is_public !== undefined) {
        updateExpr.push("is_public = :is_public");
        exprAttrValues[":is_public"] = value.is_public;
      }

      if (value.approved_emails) {
        updateExpr.push("approved_emails = :approved_emails");
        exprAttrValues[":approved_emails"] = value.approved_emails;
      }

      await client.send(
        new UpdateItemCommand({
          TableName: PROJECTS_TABLE,
          Key: marshall({ project_id: projectId }),
          UpdateExpression: `SET ${updateExpr.join(", ")}`,
          ExpressionAttributeNames: Object.keys(exprAttrNames).length
            ? exprAttrNames
            : undefined,
          ExpressionAttributeValues: marshall(exprAttrValues),
        })
      );

      res.status(200).json({ message: "Project updated successfully" });
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

      if (project.user_id !== req.user.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
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
  async (req: Request, res: Response) => {
    try {
      const { username, projectName } = req.params;
      const emailParam = (req.query.email as string | undefined)?.toLowerCase();

      const response = await client.send(
        new ScanCommand({
          TableName: PROJECTS_TABLE,
          FilterExpression: "contains(share_url, :shareUrlPart)",
          ExpressionAttributeValues: marshall({
            ":shareUrlPart": `/${username}/${projectName}`,
          }),
        })
      );

      if (!response.Items || response.Items.length === 0) {
        return res.status(404).json({ error: "Project not found" });
      }

      const project = unmarshall(response.Items[0]);
      const isPublic = project.is_public === true;
      const approvedEmails = (project.approved_emails || []).map((e: string) =>
        e.toLowerCase()
      );

      // Handle private project email validation
      if (!isPublic) {
        if (!emailParam) {
          return res.status(400).json({ error: "EMAIL_REQUIRED" });
        }

        if (!approvedEmails.includes(emailParam)) {
          return res.status(403).json({ error: "EMAIL_INVALID" });
        }
      }

      const publicProject = {
        name: project.name,
        description: project.description,
        dropbox_shared_link: project.dropbox_shared_link,
        created_at: project.created_at,
      };

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

      let dropboxAccessToken = user.dropbox.access_token;

      const tryListFiles = async (accessToken: string) => {
        const dropboxService = new DropboxService(accessToken);
        return await dropboxService.listFiles(
          project.dropbox_folder_path || ""
        );
      };

      let dropboxFiles;
      try {
        dropboxFiles = await tryListFiles(dropboxAccessToken);
      } catch (err: any) {
        const isUnauthorized = err.status === 401;

        // If token expired and refresh token available
        if (isUnauthorized && user.dropbox.refresh_token) {
          try {
            const refreshRes = await axios.post(
              "https://api.dropbox.com/oauth2/token",
              new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: user.dropbox.refresh_token,
                client_id: process.env.EXPRESS_DROPBOX_CLIENT_ID!,
                client_secret: process.env.EXPRESS_DROPBOX_CLIENT_SECRET!,
              }),
              {
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
              }
            );

            const newAccessToken = refreshRes.data.access_token;
            dropboxAccessToken = newAccessToken;

            // Update in DB
            user.dropbox.access_token = newAccessToken;
            await client.send(
              new UpdateItemCommand({
                TableName: USERS_TABLE,
                Key: marshall({ user_id: user.user_id }),
                UpdateExpression: "SET dropbox.access_token = :token",
                ExpressionAttributeValues: marshall({
                  ":token": newAccessToken,
                }),
              })
            );

            // Retry Dropbox request
            dropboxFiles = await tryListFiles(newAccessToken);
          } catch (refreshError) {
            console.error("Dropbox token refresh failed", refreshError);
            return res
              .status(401)
              .json({ error: "Dropbox session expired. Please reconnect." });
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

      res.status(200).json({ project: publicProject, images });
    } catch (error: any) {
      console.error("Get project by share URL error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to fetch project" });
    }
  }
);
