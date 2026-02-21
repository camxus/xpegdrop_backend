import { Router } from "express";
import {
  createShare,
  getShareById,
  updateShare,
  deleteShare,
  listSharesByProject
} from "../controllers/sharesController";
import { authenticate } from "../middleware/auth";

const router = Router();

/* =========================
   Share Routes
========================= */

router.use(authenticate)

// 1️⃣ Create a Share
router.post("/", createShare);

// 5️⃣ List all Shares for a Project
router.get("/project/:projectId", listSharesByProject);

// 2️⃣ Get a Share by ID + mode ('c' or 'p')
router.get("/:shareId/:mode", getShareById);

// 3️⃣ Update a Share
router.put("/:shareId", updateShare);

// 4️⃣ Delete a Share
router.delete("/:shareId", deleteShare);


export default router;