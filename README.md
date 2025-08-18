# Backend API

Express.js backend with AWS Cognito authentication and Dropbox integration.

## Setup

1. Copy `.env.example` to `.env` and fill in your configuration
2. Install dependencies: `npm install`
3. Run in development: `npm run dev`
4. Build for production: `npm run build`
5. Start production server: `npm start`

## API Endpoints

### Authentication
- `POST /api/auth/signup` - Create new user account
- `POST /api/auth/login` - User login
- `POST /api/auth/refresh-token` - Refresh access token
- `POST /api/auth/forgot-password` - Request password reset
- `POST /api/auth/confirm-password` - Confirm password reset
- `POST /api/auth/set-new-password` - Set new password

### Projects (Protected)
- `POST /api/projects` - Create new project with file upload
- `GET /api/projects` - Get user's projects
- `GET /api/projects/:projectId` - Get specific project
- `PUT /api/projects/:projectId` - Update project
- `DELETE /api/projects/:projectId` - Delete project

### Public
- `GET /api/projects/share/:username/:projectName` - Get project by share URL

## Environment Variables

See `.env.example` for required configuration.

## Database Schema

### Users Table
- user_id (string, primary key)
- username (string)
- email (string)
- first_name (string)
- last_name (string)
- bio (string, optional)
- avatar_url (object, optional)
- dropbox_access_token (string, optional)
- created_at (string)
- updated_at (string, optional)

### Projects Table
- project_id (string, primary key)
- user_id (string)
- name (string)
- description (string, optional)
- share_url (string)
- dropbox_folder_path (string, optional)
- dropbox_shared_link (string, optional)
- created_at (string)
- updated_at (string, optional)# xpegdrop_backend
