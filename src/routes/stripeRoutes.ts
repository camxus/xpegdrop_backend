import express, { Router } from "express";
import { getBillingInfo, getBillingPortalSession, stripeWebhook } from "../controllers/stripeController";
import { authenticate } from "../middleware/auth";


const router: Router = express.Router();

router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhook
)

// Everything below uses normal JSON parsing
router.use(express.json(), authenticate)

// Billing portal
router.post("/billing", getBillingInfo)
router.post("/billing/portal", getBillingPortalSession)

export default router;
