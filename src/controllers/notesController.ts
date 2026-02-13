import { asyncHandler } from "../middleware/asyncHandler";
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, DeleteItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { Request, Response } from "express";
import { authenticate, AuthenticatedRequest, getUserFromToken } from "../middleware/auth";
import { Note } from "../types";
import { createNoteSchema, updateNoteSchema } from "../utils/validation/noteValidation";
import { validationErrorHandler } from "../middleware/errorMiddleware";

const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });
const NOTES_TABLE = process.env.DYNAMODB_NOTES_TABLE || "Notes";

// CREATE Note
export const createNote = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  // Validate request body
  const { error, value } = createNoteSchema.validate(req.body);
  if (error) throw validationErrorHandler(error);

  const { project_id, media_name, content, author, timestamp } = value;

  if (!project_id || !content) {
    return res.status(400).json({ error: "project_id and content are required" });
  }

  const authHeader = req.headers.authorization;
  if (authHeader) await getUserFromToken(authHeader.substring(7)).then(user => req.user = user);

  const note: Note = {
    note_id: uuidv4(),
    project_id,
    media_name,
    user_id: req.user?.user_id || `anonymous-${uuidv4()}`,
    content,
    timestamp,
    created_at: new Date().toISOString(),
    author: req.user ? { first_name: req.user?.first_name, last_name: req?.user?.last_name } : author
  };

  try {
    await client.send(
      new PutItemCommand({
        TableName: NOTES_TABLE,
        Item: marshall(note),
      })
    );
    res.status(201).json(note);
  } catch (error: any) {
    console.error("Create note error:", error);
    res.status(500).json({ error: error.message || "Failed to create note" });
  }
});

// GET Notes by projectId
export const getNotesByProject = asyncHandler(async (req: Request, res: Response) => {
  const { projectId } = req.params;

  if (!projectId) return res.status(400).json({ error: "projectId is required" });

  try {
    const response = await client.send(
      new ScanCommand({
        TableName: NOTES_TABLE,
        FilterExpression: "project_id = :projectId",
        ExpressionAttributeValues: marshall({ ":projectId": projectId }),
      })
    );

    const notes = response.Items?.map(item => unmarshall(item)) || [];
    res.status(200).json({ notes, total: notes.length });
  } catch (error: any) {
    console.error("Get notes error:", error);
    res.status(500).json({ error: error.message || "Failed to fetch notes" });
  }
});

// GET Notes by media_name
export const getNotesByMediaName = asyncHandler(async (req: Request, res: Response) => {
  const { projectId, mediaName } = req.params;

  if (!projectId || !mediaName) {
    return res.status(400).json({ error: "projectId and mediaName are required" });
  }

  try {
    const response = await client.send(
      new ScanCommand({
        TableName: NOTES_TABLE,
        FilterExpression: "project_id = :projectId AND media_name = :mediaName",
        ExpressionAttributeValues: marshall({
          ":projectId": projectId,
          ":mediaName": mediaName,
        }),
      })
    );

    const notes = response.Items?.map((item) => unmarshall(item)) || [];
    res.status(200).json({ notes, total: notes.length });
  } catch (error: any) {
    console.error("Get notes error:", error);
    res.status(500).json({ error: error.message || "Failed to fetch notes" });
  }
});

// UPDATE Note
export const updateNote = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { noteId } = req.params;

  // Validate request body
  const { error, value } = updateNoteSchema.validate(req.body);
  if (error) throw validationErrorHandler(error);

  const { content } = value;

  const authHeader = req.headers.authorization;
  if (authHeader) await getUserFromToken(authHeader.substring(7)).then(user => req.user = user);

  if (!noteId || !content) return res.status(400).json({ error: "noteId and content are required" });

  try {
    const getRes = await client.send(
      new GetItemCommand({ TableName: NOTES_TABLE, Key: marshall({ note_id: noteId }) })
    );

    if (!getRes.Item) return res.status(404).json({ error: "Note not found" });

    const note = unmarshall(getRes.Item) as Note;

    if (!note.user_id.includes("anonymous") && req.user?.user_id !== note.user_id) {
      return res.status(403).json({ error: "user_id mismatch" });
    }

    await client.send(
      new UpdateItemCommand({
        TableName: NOTES_TABLE,
        Key: marshall({ note_id: noteId }),
        UpdateExpression: "SET #c = :content, #u = :updated_at",
        ExpressionAttributeNames: { "#c": "content", "#u": "updated_at" },
        ExpressionAttributeValues: marshall({ ":content": content, ":updated_at": new Date().toISOString() }),
      })
    );

    res.status(200).json({ message: "Note updated successfully" });
  } catch (error: any) {
    console.error("Update note error:", error);
    res.status(500).json({ error: error.message || "Failed to update note" });
  }
});

// DELETE Note
export const deleteNote = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { noteId } = req.params;

  if (!noteId) return res.status(400).json({ error: "noteId is required" });

  try {
    const getRes = await client.send(
      new GetItemCommand({ TableName: NOTES_TABLE, Key: marshall({ note_id: noteId }) })
    );

    if (!getRes.Item) return res.status(404).json({ error: "Note not found" });

    const note = unmarshall(getRes.Item) as Note;

    const authHeader = req.headers.authorization;
    if (authHeader) await getUserFromToken(authHeader.substring(7)).then(user => req.user = user);

    if (!note.user_id.includes("anonymous") && req.user?.user_id !== note.user_id) {
      return res.status(403).json({ error: "user_id mismatch" });
    }

    await client.send(
      new DeleteItemCommand({ TableName: NOTES_TABLE, Key: marshall({ note_id: noteId }) })
    );

    res.status(200).json({ message: "Note deleted successfully" });
  } catch (error: any) {
    console.error("Delete note error:", error);
    res.status(500).json({ error: error.message || "Failed to delete note" });
  }
});
