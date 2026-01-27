import { Router } from "express";
import {
  getGoogleAuthUrl,
  handleGoogleCallback,
  handleGoogleCallbackWithUpdateUser,
  getGoogleStats,
} from "../controllers/googleController";
import { authenticate } from "../middleware/auth";

const router: Router = Router();

// Public endpoint to get Google OAuth URL
router.get("/auth-url", getGoogleAuthUrl);

// Callback endpoint after Google OAuth
router.get("/callback", handleGoogleCallback);

// Optional: callback that stores tokens in DynamoDB for authenticated users
router.get("/callback/update-user", authenticate, handleGoogleCallbackWithUpdateUser);

// Authenticated endpoint to get Google Drive storage stats
router.get("/stats", authenticate, getGoogleStats);

export default router;
