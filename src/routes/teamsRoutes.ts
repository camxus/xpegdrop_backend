import express, { Router } from "express";
import {
  createTeam,
  getTeams,
  getTeam,
  updateTeam,
  deleteTeam,
  inviteMember,
  removeMember,
} from "../controllers/teamsController";
import { authenticate } from "../middleware/auth";


const router: Router = express.Router();

router.use(authenticate);

// --- Team core routes ---
router.post("/", createTeam); // create a new team
router.get("/", getTeams); // get all teams user is part of
router.get("/:teamId", getTeam); // get single team
router.put("/:teamId", updateTeam); // update team details
router.delete("/:teamId", deleteTeam); // delete a team

// --- Team member management ---
router.post("/:teamId/invite", inviteMember); // invite a new member
router.delete("/:teamId/:userId", removeMember); // remove member from team

export default router;
