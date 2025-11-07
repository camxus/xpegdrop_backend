import { Router } from "express";
import {
  checkReferral,
  createReferral,
  getUserReferrals,
  redeemReferral,
} from "../controllers/referralsController";
import { authenticate } from "../middleware/auth";

const router: Router = Router();

/**
 * @route   GET /referrals/check
 * @desc    Check if a referral code exists and is not redeemed
 * @access  Private (or Public if you want)
 */
router.get("/check", checkReferral);

/**
 * @route   POST /referrals/redeem
 * @desc    Redeem a referral code
 * @access  Private
 */
router.post("/redeem", redeemReferral);

router.use(authenticate)
/**
 * @route   POST /referrals
 * @desc    Create a new referral (max 5 per user)
 * @access  Private
 */
router.post("/", createReferral);

/**
 * @route   GET /referrals
 * @desc    Get all referrals for a specific user
 * @access  Private
 */
router.get("/", getUserReferrals);

export default router;
