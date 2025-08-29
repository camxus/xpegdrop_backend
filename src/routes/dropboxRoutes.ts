import { Router } from "express"
import {
  getDropboxAuthUrl,
  getDropboxStats,
  handleDropboxCallback,
} from "../controllers/dropboxController"
import { authenticate } from "../middleware/auth"

const router: Router = Router()

router.get("/auth-url", getDropboxAuthUrl)
router.get("/callback", handleDropboxCallback)
router.get("/stats", authenticate, getDropboxStats)

export default router