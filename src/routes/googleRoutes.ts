import express from "express";
import {
  getGoogleAuthUrl,
  handleGoogleCallback,
  handleGoogleCallbackWithUpdateUser,
  getGoogleStats,
} from "../controllers/googleController";
import { authenticate } from "../middleware/auth";

const router = express.Router();

/**
 * Step 1: Generate Google OAuth URL
 * GET /google/auth-url
 * (requires auth – links Google to an existing user)
 */
router.get("/auth-url", authenticate, getGoogleAuthUrl);

/**
 * Step 2: Google OAuth callback (no user update)
 * GET /google/callback
 * (public – Google redirects here)
 */
router.get("/callback", handleGoogleCallback);

/**
 * Step 3: Google OAuth callback + store tokens in user
 * GET /google/callback/update-user
 * (requires auth – updates Google account to logged-in user)
 */
router.get("/callback/update-user", authenticate, handleGoogleCallbackWithUpdateUser);

/**
 * Step 4: Get Google Drive storage stats
 * GET /google/stats
 * (requires auth)
 */
router.get("/stats", authenticate, getGoogleStats);

export default router;