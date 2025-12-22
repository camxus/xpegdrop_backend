import express, { Router } from "express";
import {
  createTenant,
  getTenants,
  getTenant,
  updateTenant,
  deleteTenant,
  inviteMember,
  removeMember,
  uploadAvatar,
  getTenantByHandle,
  updateMember,
  searchTenantUserByUsername,
} from "../controllers/tenantsController";
import { authenticate } from "../middleware/auth";


const router: Router = express.Router();

router.use(authenticate);

// --- Tenant core routes ---
router.post("/", createTenant); // create a new Tenant
router.get("/", getTenants); // get all Tenants user is part of
router.get("/handle/:handle", getTenantByHandle); // get single Tenant by handle
router.get("/:tenantId", getTenant); // get single Tenant
router.put("/:tenantId", uploadAvatar, updateTenant); // update Tenant details
router.delete("/:tenantId", deleteTenant); // delete a Tenant

router.delete("/:tenantId/users/search", searchTenantUserByUsername);

// --- Tenant member management ---
router.post("/:tenantId/invite", inviteMember); // invite a new member
router.patch("/:tenantId/:userId", updateMember); // invite a new member
router.delete("/:tenantId/:userId", removeMember); // remove member from Tenant

export default router;
