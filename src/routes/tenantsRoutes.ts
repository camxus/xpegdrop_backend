import express, { Router } from "express";
import {
  createTenant,
  getTenants,
  getTenant,
  updateTenant,
  deleteTenant,
  inviteMember,
  removeMember,
} from "../controllers/tenantsController";
import { authenticate } from "../middleware/auth";


const router: Router = express.Router();

router.use(authenticate);

// --- Tenant core routes ---
router.post("/", createTenant); // create a new Tenant
router.get("/", getTenants); // get all Tenants user is part of
router.get("/:tenantId", getTenant); // get single Tenant
router.put("/:tenantId", updateTenant); // update Tenant details
router.delete("/:tenantId", deleteTenant); // delete a Tenant

// --- Tenant member management ---
router.post("/:tenantId/invite", inviteMember); // invite a new member
router.delete("/:tenantId/:userId", removeMember); // remove member from Tenant

export default router;
