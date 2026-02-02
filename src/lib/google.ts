import { google, drive_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { User } from "../types";
import { createThumbnailFromURL } from "../utils/file-utils";

const UPLOAD_BATCH_SIZE = 3;
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION_CODE,
});

export class GoogleDriveService {
  private drive: drive_v3.Drive;
  private oauth: OAuth2Client;

  constructor(accessToken: string, refreshToken?: string) {
    this.oauth = new google.auth.OAuth2(
      process.env.GDRIVE_CLIENT_ID,
      process.env.GDRIVE_CLIENT_SECRET,
    );

    this.oauth.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    this.drive = google.drive({ version: "v3", auth: this.oauth });
  }

  // ----------------------
  // Storage prefix helper
  // ----------------------
  public getStoragePrefix(folderPath: string = ""): string {
    return `fframess/${folderPath}`
  }

  // -------------------------
  // Helpers
  // -------------------------

  private async findFolder(name: string, parentId?: string) {
    const q = [
      `mimeType='application/vnd.google-apps.folder'`,
      `name='${name}'`,
      parentId ? `'${parentId}' in parents` : null,
      "trashed=false",
    ].filter(Boolean).join(" and ");

    const res = await this.drive.files.list({
      q,
      fields: "files(id,name)",
    });

    return res.data.files?.[0] ?? null;
  }

  private getDownloadUrl(fileId: string) {
    return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }

  // -------------------------
  // Check if folder exists
  // -------------------------
  async folderExists(folderName: string, parentId?: string): Promise<boolean> {
    const folder = await this.findFolder(folderName, parentId);
    return !!folder; // true if folder exists, false otherwise
  }

  // -------------------------
  // Folder
  // -------------------------
  async createUniqueFolder(name: string, parentId?: string) {
    let count = 0;

    // Use getStoragePrefix to namespace under "fframess/"
    const baseFolderPath = this.getStoragePrefix(name);

    // Split into segments, e.g. "fframess/myFolder" => ["fframess", "myFolder"]
    const folderSegments = baseFolderPath.split("/");

    let currentParentId = parentId;
    let folder: drive_v3.Schema$File | null = null;

    // Traverse all segments except the last
    for (let i = 0; i < folderSegments.length - 1; i++) {
      const segment = folderSegments[i];

      // Check if folder exists under currentParentId
      folder = await this.folderExists(segment, currentParentId)
        ? await this.findFolder(segment, currentParentId)
        : null;

      if (!folder) {
        const res = await this.drive.files.create({
          requestBody: {
            name: segment,
            mimeType: "application/vnd.google-apps.folder",
            parents: currentParentId ? [currentParentId] : undefined,
          },
          fields: "id,name",
        });
        folder = res.data;
      }

      currentParentId = folder.id || undefined;
    }

    // Now handle the last segment (final folder) and ensure uniqueness
    let finalFolderName = folderSegments[folderSegments.length - 1];
    let finalFolderExists = await this.folderExists(finalFolderName, currentParentId);

    while (finalFolderExists) {
      count++;
      finalFolderName = `${folderSegments[folderSegments.length - 1]}-${count}`;
      finalFolderExists = await this.folderExists(finalFolderName, currentParentId);
    }

    // Create the final folder
    const res = await this.drive.files.create({
      requestBody: {
        name: finalFolderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: currentParentId ? [currentParentId] : undefined,
      },
      fields: "id,name",
    });

    return res.data;
  }

  async deleteFolder(folderId: string) {
    await this.drive.files.delete({ fileId: folderId });
  }

  // -------------------------
  // Upload
  // -------------------------

  async upload(files: File[], folderName: string): Promise<{ folder_id: string; share_link: string }> {
    const folder = await this.createUniqueFolder(folderName);

    for (let i = 0; i < files.length; i += UPLOAD_BATCH_SIZE) {
      const batch = files.slice(i, i + UPLOAD_BATCH_SIZE);

      await Promise.all(
        batch.map(async (file) => {
          const buffer = Buffer.from(await file.arrayBuffer());

          await this.drive.files.create({
            requestBody: {
              name: file.name,
              parents: [folder?.id!],
            },
            media: {
              body: buffer,
            },
          });
        }),
      );

      await new Promise(r => setTimeout(r, 500));
    }

    // Make folder public
    await this.drive.permissions.create({
      fileId: folder.id!,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });

    return {
      folder_id: folder.id!,
      share_link: `https://drive.google.com/drive/folders/${folder.id}`,
    };
  }

  // -------------------------
  // Move a folder in Google Drive
  // -------------------------
  async moveFolder(folderId: string, newParentId: string): Promise<void> {
    try {
      // 1. Get current parents
      const folder = await this.drive.files.get({
        fileId: folderId,
        fields: "id, name, parents",
      });

      const currentParents = folder.data.parents || [];

      // 2. Update parents: add new parent, remove old parents
      await this.drive.files.update({
        fileId: folderId,
        addParents: newParentId,
        removeParents: currentParents.join(","),
        fields: "id, parents",
      });
    } catch (err: any) {
      console.error("Error moving Google Drive folder:", err);
      const e = new Error("Failed to move Google Drive folder");
      (e as any).status = err.status;
      throw e;
    }
  }

  // -------------------------
  // List files
  // -------------------------

  async listFiles(folderId: string): Promise<{
    name: string;
    preview_url: string;
    thumbnail_url: string;
    thumbnail: Buffer;
    full_file_url: string;
  }[]> {
    const imageRegex = /\.(jpg|jpeg|png|gif|webp|tiff|tif|heic|heif)$/i;
    const videoRegex = /\.(mp4|mov|webm|mkv|m4v)$/i;

    const res = await this.drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "files(id,name,mimeType,size,webViewLink,thumbnailLink)",
    });

    return Promise.all(
      (res.data.files ?? []).map(async (file) => {
        let thumbnail: Buffer = Buffer.from("");
        let thumbnail_url = "";

        const downloadUrl = this.getDownloadUrl(file.id!);
        const hasThumbnailLink = Boolean(file.thumbnailLink);

        if (hasThumbnailLink) {
          // Use Google UI thumbnail if available
          thumbnail_url = file.thumbnailLink!.replace("=s220", "=s1024");
        }

        // Fallback: generate thumbnail for images/videos from download URL
        if (!hasThumbnailLink && (imageRegex.test(file.name!) || videoRegex.test(file.name!))) {
          thumbnail = await createThumbnailFromURL(downloadUrl);
        }

        return {
          name: file.name!,
          preview_url: file.webViewLink!,
          thumbnail_url,
          thumbnail,
          full_file_url: downloadUrl, // direct download
        };
      }),
    );
  }

  // -------------------------
  // Delete file
  // -------------------------

  async deleteFile(fileId: string) {
    await this.drive.files.delete({ fileId });
  }

  // -------------------------
  // Storage
  // -------------------------

  async getStorageSpaceUsage(): Promise<{ used: number; allocated: number; used_percent: number }> {
    const res = await this.drive.about.get({ fields: "storageQuota" });

    const quota = res.data.storageQuota!;
    const used = Number(quota.usage);
    const allocated = Number(quota.limit);

    return {
      used,
      allocated,
      used_percent: allocated ? (used / allocated) * 100 : 0,
    };
  }

  // -------------------------
  // User info
  // -------------------------

  async getUserInfo(): Promise<{ email: string; first_name: string; last_name: string; account_id: string }> {
    const res = await this.drive.about.get({ fields: "user" });
    const displayName = res.data.user?.displayName ?? "";

    return {
      email: res.data.user?.emailAddress!,
      first_name: displayName.split(" ")[0] || "",
      last_name: displayName.split(" ").slice(1).join(" ") || "",
      account_id: res.data.user?.permissionId!,
    };
  }

  // -------------------------
  // Token refresh
  // -------------------------

  async refreshGoogleToken(user: User) {
    if (!user.google?.refresh_token) throw new Error("No Google refresh token");

    this.oauth.setCredentials({ refresh_token: user.google.refresh_token });
    const { credentials } = await this.oauth.refreshAccessToken();

    await client.send(
      new UpdateItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id: user.user_id }),
        UpdateExpression: "SET gdrive.access_token = :t",
        ExpressionAttributeValues: marshall({ ":t": credentials.access_token }),
      }),
    );

    return credentials.access_token!;
  }
}
