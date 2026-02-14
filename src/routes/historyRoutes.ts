import { Router } from "express";
import {
  createProjectHistory,
  getProjectHistory,
  updateProjectHistory,
  deleteProjectHistory,
} from "../controllers/historyController";
import { authenticate } from "../middleware/auth"; // your auth middleware

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * @route   POST /history
 * @desc    Create a project history record
 */
router.post("/", createProjectHistory);

/**
 * @route   GET /history/:project_id
 * @desc    Get all history records for a project
 */
router.get("/:project_id", getProjectHistory);

/**
 * @route   PATCH /history/:project_id/:project_history_id
 * @desc    Update a specific project history record
 */
router.patch("/:project_id/:project_history_id", updateProjectHistory);

/**
 * @route   DELETE /history/:project_id/:id
 * @desc    Delete a specific project history record
 */
router.delete("/:project_id/:project_history_id", deleteProjectHistory);

export default router;
