export interface EXIFData {
  /* =====================
   * IFD0 / Basic Image
   * ===================== */
  Make?: string;
  Model?: string;
  Software?: string;
  HostComputer?: string;

  Orientation?: string; // e.g. "Rotate 90 CW"
  XResolution?: number;
  YResolution?: number;
  ResolutionUnit?: "inches" | "cm" | number;

  ExifImageWidth?: number;
  ExifImageHeight?: number;

  CreateDate?: Date;
  ModifyDate?: Date;

  /* =====================
   * EXIF / Camera
   * ===================== */
  ExposureTime?: number; // seconds (0.02)
  ShutterSpeedValue?: number;
  FNumber?: number;
  ApertureValue?: number;
  BrightnessValue?: number;
  ExposureCompensation?: number;

  ISO?: number;
  ISOSpeedRatings?: number;

  ExposureMode?: string;
  ExposureProgram?: string;
  MeteringMode?: string;

  Flash?: string;
  WhiteBalance?: string;

  FocalLength?: number;
  FocalLengthIn35mmFormat?: number;

  LensMake?: string;
  LensModel?: string;
  LensInfo?: number[];

  SceneType?: string;
  SceneCaptureType?: string;
  SensingMethod?: string;

  SubjectArea?: Uint16Array;

  DateTimeOriginal?: Date;
  DateTimeDigitized?: Date;

  /* =====================
   * GPS (RAW EXIF)
   * ===================== */
  GPSLatitude?: number[];       // [deg, min, sec]
  GPSLatitudeRef?: "N" | "S";

  GPSLongitude?: number[];      // [deg, min, sec]
  GPSLongitudeRef?: "E" | "W";

  GPSAltitude?: number;
  GPSAltitudeRef?: number;

  GPSTimeStamp?: string | number[];
  GPSDateStamp?: string;

  GPSImgDirection?: number;
  GPSImgDirectionRef?: string;

  GPSDestBearing?: number;
  GPSDestBearingRef?: string;

  GPSSpeed?: number;
  GPSSpeedRef?: string;

  GPSHPositioningError?: number;

  /* =====================
   * Normalized / Derived
   * ===================== */
  latitude?: number;  // decimal degrees
  longitude?: number; // decimal degrees

  /* =====================
   * Misc
   * ===================== */
  ColorSpace?: number;
  ComponentsConfiguration?: Uint8Array;
  CompositeImage?: string;

  MakerNote?: Record<string, any>;
  IPTC?: Record<string, any>;
  XMP?: Record<string, any>;
}

export interface S3Location {
  bucket: string
  key: string
}
export interface SignUpInput {
  username: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  bio?: string;
  avatar?: S3Location;
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
  avatar?: S3Location | string;
  expo?: {
    push_token: string
  }
  dropbox?: {
    access_token?: string;
    refresh_token?: string;
  };
  stripe?: {
    customer_id?: string;
  };

  membership?: {
    membership_id?: string;
    status?: "active" | "past_due" | "canceled" | "incomplete" | "trialing" | string;
  };
  created_at: string;
  updated_at?: string;
}

export interface Project {
  project_id: string;
  tenant_id?: string;
  user_id: string;
  name: string;
  description?: string | null;
  share_url: string;
  is_public: boolean;
  approved_emails: string[];
  approved_users: { user_id: string, role: string}[];
  approved_tenant_users: { user_id: string, role: string }[]
  can_download: boolean,
  dropbox_folder_path?: string;
  dropbox_shared_link?: string;
  b2_folder_path?: string;
  b2_shared_link?: string;
  created_at: string;
  updated_at?: string;
  status: "initiated" | "created"
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
  avatar?: S3Location;
  dropbox?: {
    access_token?: string;
    refresh_token?: string;
  };
}

export interface Note {
  note_id: string;
  project_id: string;
  media_name: string;
  user_id: string;
  content: string;
  created_at: string;
  updated_at?: string;
  author: { first_name: string, last_name: string }
}

export interface Tenant {
  tenant_id: string;
  handle: string;
  name: string;
  description?: string;
  members?: {
    user_id: string;
    role: "admin" | "editor" | "viewer";
    joined_at: string;
  }[];
  avatar?: S3Location | string;
  created_by: string;
  created_at: string;
  updated_at?: string;
}

export interface Referral {
  referral_id: string;
  created_by: string;
  code: string;
  created_at: string;
  updated_at?: string;
  redeemed?: boolean;
}

export interface Metadata {
  project_id: string;
  user_id: string;
  media_name: string;
  exif_data: EXIFData;
  image_hash?: string;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  notification_id: string;
  user_id: string;
  actor_id: string
  type: string;
  message: string;
  link?: string;
  expo_uri?: string;
  expo_push_token?: string;
  is_read: boolean;
  created_at: string;
  updated_at: string;
}