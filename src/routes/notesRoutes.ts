import express, { Router } from "express";
import {
  createNote,
  updateNote,
  deleteNote,
  getNotesByProject,
  getNotesByImage,
} from "../controllers/notesController";
import { authenticate } from "../middleware/auth";

const router: Router = express.Router();

// Create a new note
router.post("/", createNote);

// Get all notes for a project
router.get("/:projectId", getNotesByProject);

// Get all notes for a project
router.get("/:projectId/:imageName", getNotesByImage);

// Update a note by ID
router.put("/:noteId", updateNote);

// Delete a note by ID
router.delete("/:noteId", authenticate, deleteNote);

export default router;
