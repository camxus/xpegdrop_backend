import { Router } from "express";
import {
  createNotification,
  getNotifications,
  markNotificationRead,
  deleteNotification,
} from "../controllers/notificationsController";
import { authenticate } from "../middleware/auth"; // your auth middleware

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * @route   POST /notifications
 * @desc    Create a notification for the authenticated user
 */
router.post("/", createNotification);

/**
 * @route   GET /notifications
 * @desc    Get all notifications for the authenticated user
 */
router.get("/", getNotifications);

/**
 * @route   PATCH /notifications/:id/read
 * @desc    Mark a notification as read
 */
router.patch("/:id/read", markNotificationRead);

/**
 * @route   DELETE /notifications/:id
 * @desc    Delete a notification
 */
router.delete("/:id", deleteNotification);

export default router;
