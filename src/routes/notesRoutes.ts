import express, { Router } from "express";
import {
  createNote,
  getNotes,
  updateNote,
  deleteNote,
} from "../controllers/notesController";
import { authenticate } from "../middleware/auth";

const router: Router = express.Router();

// Create a new note
router.post("/", createNote);

// Get all notes for a project
router.get("/:projectId", getNotes);

// Update a note by ID
router.put("/:noteId", updateNote);

// Delete a note by ID
router.delete("/:noteId", authenticate, deleteNote);

export default router;
