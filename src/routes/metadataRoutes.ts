import express from "express";
import {
  createImageMetadata,
  batchCreateImageMetadata,
  getImageMetadata,
  getProjectMetadata,
  deleteImageMetadata,
} from "../controllers/metadataController";
import { authenticate } from "../middleware/auth";

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticate);

/**
 * Create metadata for a single image
 * POST /metadata
 */
router.post("/", createImageMetadata);

/**
 * Batch create metadata for a project (upload flow)
 * POST /metadata/batch
 */
router.post("/batch", batchCreateImageMetadata);

/**
 * Get all metadata for a project
 * GET /metadata/:project_id
 */
router.get("/:project_id", getProjectMetadata);

/**
 * Get metadata for a single image
 * GET /metadata/:project_id/:image_name
 */
router.get("/:project_id/:image_name", getImageMetadata);

/**
 * Delete metadata for a single image
 * DELETE /metadata/:project_id/:image_name
 */
router.delete("/:project_id/:image_name", deleteImageMetadata);

export default router;
