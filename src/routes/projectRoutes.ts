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
  getTeamProjectByShareUrl,
  getTeamProjects,
} from '../controllers/projectController';
import { authenticate } from '../middleware/auth';

const router: Router = express.Router();

// Public route for share URLs
router.get('/share/:username/:projectName', getProjectByShareUrl);
router.get('/share/:teamName/:username/:projectName', getTeamProjectByShareUrl);

// Protected routes (require authentication)
router.use(authenticate);
router.post('/', uploadMiddleware, createProject);
router.get('/', getProjects);
router.get('/:projectId', getProject);
router.put('/:projectId', updateProject);
router.delete('/:projectId', deleteProject);

router.get('/team/:teamId', getTeamProjects);

router.post("/:projectId/files", uploadMiddleware, addProjectFiles);
router.delete("/:projectId/files/:fileName", removeProjectFile);

export default router;