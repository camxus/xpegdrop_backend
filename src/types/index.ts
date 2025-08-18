export interface SignUpInput {
  username: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  bio?: string;
  avatar_url?: string;
  dropbox?: {
    access_token?: string;
    refresh_token?: string;
  };
}

export interface SignInInput {
  username: string;
  password: string;
}

export interface User {
  user_id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  bio?: string;
  avatar_url?: string;
  dropbox?: {
    access_token?: string;
    refresh_token?: string;
  };
  created_at: string;
  updated_at?: string;
}

export interface Project {
  project_id: string;
  user_id: string;
  name: string;
  description?: string | null;
  share_url: string;
  is_public: boolean;
  approved_emails: string[];
  dropbox_folder_path?: string;
  dropbox_shared_link?: string;
  created_at: string;
  updated_at?: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  files: File[];
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
}
export interface UpdateUserInput {
  first_name?: string;
  last_name?: string;
  bio?: string;
  avatar_url?: string;
  dropbox?: {
    access_token?: string;
    refresh_token?: string;
  };
}
