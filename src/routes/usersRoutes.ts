import express, { Router } from 'express';
import {
  getUser,
  getCurrentUser,
  updateUser,
  deleteUser,
  getUserByUsername,
  updateDropboxToken,
} from '../controllers/usersController';
import { authenticate } from '../middleware/auth';
import { uploadAvatar } from '../controllers/authController';

const router: Router = express.Router();

// Public routes
router.get('/username/:username', getUserByUsername);
router.get('/:userId', getUser);

// Protected routes (require authentication)
router.use(authenticate);
router.get('/', getCurrentUser);
router.put('/', uploadAvatar, updateUser);
router.delete('/', deleteUser);
router.put('/dropbox-token', updateDropboxToken);

export default router;