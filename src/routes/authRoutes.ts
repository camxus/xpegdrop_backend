import express, { Router } from "express";
import {
  createRating,
  getRatings,
  updateRating,
  deleteRating,
} from "../controllers/ratingsController";
import { authenticate } from "../middleware/auth";

const router: Router = express.Router();

// Create a new rating
router.post("/", createRating);

// Get all ratings for a project
router.get("/:projectId", getRatings);

// Update a rating by ID
router.put("/:ratingId", authenticate, updateRating);

// Delete a rating by ID
router.delete("/:ratingId", authenticate, deleteRating);

export default router;
