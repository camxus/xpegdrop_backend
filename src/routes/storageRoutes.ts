// storageRoutes.ts
import { Router } from "express";
import { getStorageStats } from "../controllers/storageController"; // adjust path if needed
import { authenticate } from "../middleware/auth";

const router: Router = Router();

/**
 * @route   GET /api/storage
 * @desc    Get storage usage stats for a user (optionally for a tenant)
 * @access  Private
 */
router.get("/stats", authenticate, getStorageStats);

export default router;
