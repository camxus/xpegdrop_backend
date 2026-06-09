import { Router } from 'express';
import multer from 'multer';
import {
  createAgentFromImage,
  interactWithAgent,
  getAgentSessionHandler,
  getSessionInteractions,
  saveEnvironment,
  loadEnvironment,
} from '../controllers/agentsController';
import { authenticate } from '../middleware/auth';

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();

router.use(authenticate);

router.post('/from-image', upload.single('image'), createAgentFromImage);
router.post('/:sessionId/interact', interactWithAgent);
router.get('/:sessionId', getAgentSessionHandler);
router.get('/:sessionId/interactions', getSessionInteractions);
router.post('/:sessionId/environment', saveEnvironment);
router.get('/:sessionId/environment', loadEnvironment);

export default router;
