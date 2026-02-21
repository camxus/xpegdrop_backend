import express, { Router } from 'express';
import {
  createProject,
  getProjects,
  getProject,
  updateProject,
  deleteProject,
  getProjectByProjectUrl,
  uploadMiddleware,
  addProjectFiles,
  removeProjectFile,
  getTenantProjectByProjectUrl,
  getTenantProjects,
  getProjectByShareId,
} from '../controllers/projectsController';
import { authenticate } from '../middleware/auth';

const router: Router = express.Router();

// Public route for project URLs
router.get('/share/:username/:mode/:shareId', getProjectByShareId);

// Protected routes (require authentication)
router.use(authenticate);
router.get('/project/:username/:projectName', getProjectByProjectUrl);
router.get('/project/tenant/:tenantHandle/:username/:projectName', getTenantProjectByProjectUrl);
router.post('/', uploadMiddleware, createProject);
router.get('/', getProjects);
router.get('/:projectId', getProject);
router.put('/:projectId', updateProject);
router.delete('/:projectId', deleteProject);

router.get('/tenant/:tenantId', getTenantProjects);

router.post("/:projectId/files", uploadMiddleware, addProjectFiles);
router.delete("/:projectId/files/:fileName", removeProjectFile);

export default router;