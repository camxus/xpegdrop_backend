import express, { Router } from "express";
import {
  signup,
  login,
  refreshToken,
  forgotPassword,
  confirmPassword,
  setNewPassword,
  uploadAvatar,
  getPresignURL,
} from "../controllers/authController";
import { authenticate } from "../middleware/auth";

const router: Router = express.Router();

router.post("/signup", uploadAvatar, signup);
router.post("/login", login);
router.post("/refresh-token", authenticate, refreshToken);
router.post("/forgot-password", forgotPassword);
router.post("/confirm-password", confirmPassword);
router.post("/set-new-password", setNewPassword);
router.get("/presign-url", getPresignURL);

export default router;
