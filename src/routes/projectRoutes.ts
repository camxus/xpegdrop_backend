import express, { Router } from 'express';
import {
  createProject,
  getProjects,
  getProject,
  updateProject,
  deleteProject,
  getProjectByShareUrl,
  uploadMiddleware,
  addProjectFiles,
  removeProjectFile,
  getTenantProjectByShareUrl,
  getTenantProjects,
} from '../controllers/projectController';
import { authenticate } from '../middleware/auth';

const router: Router = express.Router();

// Public route for share URLs
router.get('/share/:username/:projectName', getProjectByShareUrl);
router.get('/share/tenant/:tenantHandle/:username/:projectName', getTenantProjectByShareUrl);

// Protected routes (require authentication)
router.use(authenticate);
router.post('/', uploadMiddleware, createProject);
router.get('/', getProjects);
router.get('/:projectId', getProject);
router.put('/:projectId', updateProject);
router.delete('/:projectId', deleteProject);

router.get('/tenant/:tenantId', getTenantProjects);

router.post("/:projectId/files", uploadMiddleware, addProjectFiles);
router.delete("/:projectId/files/:fileName", removeProjectFile);

export default router;