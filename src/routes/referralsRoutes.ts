import { Router } from "express";
import {
  createReferral,
  getUserReferrals,
  redeemReferral,
} from "../controllers/referralsController";
import { authenticate } from "../middleware/auth";

const router: Router = Router();

router.use(authenticate)
/**
 * @route   POST /referrals
 * @desc    Create a new referral (max 5 per user)
 * @access  Private
 */
router.post("/", createReferral);

/**
 * @route   GET /referrals/:userId
 * @desc    Get all referrals for a specific user
 * @access  Private
 */
router.get("/:userId", getUserReferrals);

/**
 * @route   POST /referrals/redeem
 * @desc    Redeem a referral code
 * @access  Private
 */
router.post("/redeem", redeemReferral);

export default router;
