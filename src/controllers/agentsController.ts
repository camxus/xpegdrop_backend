import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/auth';
import { createSession, buildCapabilities, createInteraction, resolveCapabilityExecution } from '../utils/agentUtils';
import { putAgentSession, getAgentSession, querySessionInteractions, putAgentInteraction } from '../services/agentService';
import { AuthenticatedRequest } from '../middleware/auth';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Project } from '../types';
import { BackblazeService } from '../lib/backblaze';
import { DropboxService } from '../lib/dropbox';
import fetch from 'node-fetch';

const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });
const TEMP_BUCKET = process.env.EXPRESS_S3_TEMP_BUCKET!;
const APP_BUCKET = process.env.EXPRESS_S3_APP_BUCKET!;

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const PROJECTS_TABLE = process.env.DYNAMODB_PROJECTS_TABLE || 'Projects';
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || 'Users';
const B2_BUCKET_ID = process.env.EXPRESS_B2_BUCKET_ID!;

export const createAgentFromImage = asyncHandler(async (req: AuthenticatedRequest & { file?: Express.Multer.File }, res: Response) => {
  const file = req.file || null;
  const { customInstructions, agentTypeHint, imageId, projectId, mediaName } = (req as any).body || {};

  let s3Location: { bucket: string; key: string; url?: string } | undefined;

  if (file) {
    const buffer = Buffer.from(file.buffer);
    const tempKey = `agents/temp/${req.user!.user_id}/${Date.now()}-${file.originalname}`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: TEMP_BUCKET,
        Key: tempKey,
        Body: buffer,
        ContentType: file.mimetype,
      })
    );

    const appKey = `agents/${req.user!.user_id}/${imageId || Date.now()}/${file.originalname}`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: APP_BUCKET,
        Key: appKey,
        Body: buffer,
        ContentType: file.mimetype,
      })
    );

    const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: APP_BUCKET, Key: appKey }), { expiresIn: 3600 });

    s3Location = { bucket: APP_BUCKET, key: appKey, url };
  } else if (imageId && projectId && mediaName) {
    const projectResponse = await ddbClient.send(
      new GetItemCommand({
        TableName: PROJECTS_TABLE,
        Key: marshall({ project_id: projectId }),
      })
    );

    if (!projectResponse.Item) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const project = unmarshall(projectResponse.Item) as Project;

    const userResponse = await ddbClient.send(
      new GetItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id: project.user_id }),
      })
    );

    if (!userResponse.Item) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = unmarshall(userResponse.Item) as any;

    let buffer: Buffer | undefined;
    let contentType = 'application/octet-stream';

    if (project.b2_folder_path && project.b2_shared_link) {
      const b2Service = new BackblazeService(B2_BUCKET_ID, project.user_id, project.tenant_id);
      await b2Service.authorize();

      const files = await b2Service.listFilesRaw(project.b2_folder_path);
      const foundFile = files.find((f: any) => f.fileName.split('/').pop() === mediaName);

      if (!foundFile) {
        return res.status(404).json({ error: 'File not found in Backblaze storage' });
      }

      const downloadUrl = await b2Service.getFileDownloadUrl(foundFile.fileName);

      contentType = foundFile.contentType || 'application/octet-stream';
      const fileResponse = await fetch(downloadUrl);
      if (!fileResponse.ok) {
        return res.status(400).json({ error: `Failed to fetch B2 file: ${fileResponse.statusText}` });
      }
      buffer = Buffer.from(await fileResponse.arrayBuffer());
    } else if (project.dropbox_folder_path && user.dropbox?.access_token) {
      const dropboxService = new DropboxService(user.dropbox.access_token);

      try {
        const fileUrl = await dropboxService.getFileTemporaryLink(`${project.dropbox_folder_path}/${mediaName}`);
        const fileResponse = await fetch(fileUrl);
        if (!fileResponse.ok) {
          return res.status(400).json({ error: `Failed to fetch Dropbox file: ${fileResponse.statusText}` });
        }
        buffer = Buffer.from(await fileResponse.arrayBuffer());
      } catch (err: any) {
        const isUnauthorized = err.status === 401;

        if (isUnauthorized && user.dropbox?.refresh_token) {
          const refreshedToken = await dropboxService.refreshDropboxToken(user);
          const refreshedService = new DropboxService(refreshedToken);

          const fileUrl = await refreshedService.getFileTemporaryLink(`${project.dropbox_folder_path}/${mediaName}`);
          const fileResponse = await fetch(fileUrl);
          if (!fileResponse.ok) {
            return res.status(400).json({ error: `Failed to fetch Dropbox file: ${fileResponse.statusText}` });
          }
          buffer = Buffer.from(await fileResponse.arrayBuffer());
        } else {
          throw err;
        }
      }
    } else if (project.google_folder_id && user.google?.access_token) {
      const { GoogleDriveService } = await import('../lib/drive');

      const googleService = new GoogleDriveService(user.google.access_token, user.google.refresh_token);

      try {
        const files = await googleService.listFiles(project.google_folder_id);
        const foundFile = files.find((f: any) => f.name === mediaName);

        if (!foundFile) {
          return res.status(404).json({ error: 'File not found in Google Drive storage' });
        }

        contentType = foundFile.type || 'application/octet-stream';
        const fileResponse = await fetch(foundFile.full_file_url);
        if (!fileResponse.ok) {
          return res.status(400).json({ error: `Failed to fetch Google Drive file: ${fileResponse.statusText}` });
        }
        buffer = Buffer.from(await fileResponse.arrayBuffer());
      } catch (err: any) {
        const isUnauthorized = err.status === 401;

        if (isUnauthorized && user.google?.refresh_token) {
          const refreshedToken = await googleService.refreshGoogleToken(user);
          const refreshedService = new GoogleDriveService(refreshedToken);

          const files = await refreshedService.listFiles(project.google_folder_id);
          const foundFile = files.find((f: any) => f.name === mediaName);

          if (!foundFile) {
            return res.status(404).json({ error: 'File not found in Google Drive storage' });
          }

          contentType = foundFile.type || 'application/octet-stream';
          const fileResponse = await fetch(foundFile.full_file_url);
          if (!fileResponse.ok) {
            return res.status(400).json({ error: `Failed to fetch Google Drive file: ${fileResponse.statusText}` });
          }
          buffer = Buffer.from(await fileResponse.arrayBuffer());
        } else {
          throw err;
        }
      }
    }

    if (!buffer) {
      return res.status(400).json({ error: 'Could not fetch file from storage provider' });
    }

    const appKey = `agents/${req.user!.user_id}/${imageId}/${mediaName}`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: APP_BUCKET,
        Key: appKey,
        Body: buffer,
        ContentType: contentType,
      })
    );

    const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: APP_BUCKET, Key: appKey }), { expiresIn: 3600 });
    s3Location = { bucket: APP_BUCKET, key: appKey, url };
  }

  const allowedAgentTypes = new Set([
    'document-processor',
    'visual-qa',
    'data-extractor',
    'image-analyzer',
    'content-classifier',
    'metadata-enricher',
    'generic',
  ]);
  const agentType = allowedAgentTypes.has(agentTypeHint)
    ? (agentTypeHint as any)
    : 'image-analyzer';

  const session = createSession(
    req.user!.user_id,
    imageId || `image-${Date.now()}`,
    agentType,
    {
      objects: ['text', 'table'], scene: 'document', confidence: 0.95, dominantColors: [], inferredContext: { useCase: 'general', domain: 'document', dataTypes: [] },
      suggestedAgentType: agentType
    },
    customInstructions
  );

  if (s3Location) {
    (session.context_data as any).image_s3_location = s3Location;
  }

  await putAgentSession(session);

  res.status(201).json({
    data: {
      session_id: session.session_id,
      agent_type: session.agent_type,
      status: session.status,
      context_data: {
        ...session.context_data,
        capabilities: session.capabilities,
      },
      capabilities: session.capabilities,
      vision_analysis: session.context_data.vision_analysis,
      image_url: s3Location?.url || null,
      expires_at: session.expires_at,
    },
  });
});

export const interactWithAgent = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { sessionId } = req.params;
  const { query, capabilityName, parameters } = req.body;

  const session = await getAgentSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.status === 'expired') {
    return res.status(409).json({ error: 'Session expired' });
  }

  const imageS3 = (session.context_data as any)?.image_s3_location as { bucket?: string; key?: string; url?: string } | undefined;
  const executed = resolveCapabilityExecution({
    capabilityName,
    agentType: session.agent_type,
    query,
    parameters,
    imageId: session.image_id,
    imageS3,
  });
  const responseText = executed.responseText;
  const responseData = executed.responseData;

  const interaction = createInteraction(sessionId, query, capabilityName, responseText, 'active', responseData);

  await putAgentInteraction(interaction);

  res.status(200).json({
    data: {
      interaction_id: interaction.interaction_id,
      session_id: interaction.session_id,
      query: interaction.query,
      capability_name: interaction.capability_name,
      response: interaction.response,
      response_data: interaction.response_data,
      status: interaction.status,
      execution_time_ms: interaction.execution_time_ms,
      created_at: interaction.created_at,
    },
  });
});

export const getAgentSessionHandler = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { sessionId } = req.params;
  const session = await getAgentSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.status(200).json({
    data: {
      session_id: session.session_id,
      agent_type: session.agent_type,
      status: session.status,
      context_data: session.context_data,
      capabilities: session.capabilities,
      created_at: session.created_at,
      expires_at: session.expires_at,
    },
  });
});

export const getSessionInteractions = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { sessionId } = req.params;
  const limit = parseInt((req.query.limit as string) || '50', 10);
  const interactions = await querySessionInteractions(sessionId, limit);
  res.status(200).json({
    data: interactions,
    pagination: { total: interactions.length, limit, offset: 0 },
  });
});

export const saveEnvironment = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { sessionId, nodes, edges } = req.body;
  const session = await getAgentSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const updated = {
    ...session,
    context_data: {
      ...session.context_data,
      nodes,
      edges,
    },
    status: 'completed' as const,
  };

  await putAgentSession(updated);

  res.status(200).json({
    data: {
      session_id: updated.session_id,
      environment_id: updated.session_id,
      nodes,
      edges,
      saved_at: Date.now(),
    },
  });
});

export const loadEnvironment = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { sessionId } = req.params;
  const session = await getAgentSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.status(200).json({
    data: {
      session_id: session.session_id,
      nodes: (session.context_data as any).nodes || [],
      edges: (session.context_data as any).edges || [],
      saved_at: session.created_at,
    },
  });
});