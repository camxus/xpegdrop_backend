import { Router } from "express"
import {
  getDropboxAuthUrl,
  handleDropboxCallback,
} from "../controllers/dropboxController"

const router = Router()

router.get("/auth-url", getDropboxAuthUrl)
router.get("/callback", handleDropboxCallback)

export default router