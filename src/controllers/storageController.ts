import { Response } from "express";

import { asyncHandler } from "../middleware/asyncHandler";
import { AuthenticatedRequest } from "../middleware/auth";
import { BackblazeService } from "../utils/backblaze";

require("dotenv").config();

const B2_BUCKET_ID = process.env.EXPRESS_B2_BUCKET_ID!;

export const getStorageStats = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.query.tenantId as string | undefined

  try {
    // Initialize Backblaze service
    const b2Service = new BackblazeService(B2_BUCKET_ID, req.user!.user_id, tenantId);

    // Get storage usage
    const storageInfo = await b2Service.getStorageSpaceUsage(req.user!.membership?.membership_id);

    return res.json(storageInfo);
  } catch (error: any) {
    console.error("Failed to fetch B2 storage stats:", error);
    return res.status(500).json({ error: "Failed to fetch storage stats" });
  }
});
