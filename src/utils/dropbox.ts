import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Dropbox } from "../../sdk/dropbox";
import type { sharing, files, users } from "../../sdk/dropbox";
import axios from "axios";
import qs from "qs";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { User } from "../types";

const UPLOAD_BATCH_SIZE = 3;
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION_CODE,
});

export class DropboxService {
  private dbx: Dropbox;

  constructor(accessToken: string) {
    this.dbx = new Dropbox({
      accessToken,
      fetch: fetch,
    });
  }

  async folderExists(folderName: string): Promise<boolean> {
    try {
      await this.dbx.filesGetMetadata({ path: folderName });
      return true; // Folder exists
    } catch (err: any) {
      if (err?.error?.error_summary?.includes("path/not_found")) {
        return false; // Folder does not exist
      }
      console.error("Error checking Dropbox folder existence:", err);

      const e = new Error("Failed to check Dropbox folder existence");
      (e as any).status = err.status; // attach the status code
      throw e; // throw a proper Error
    }
  }

  async moveFolder(fromPath: string, toPath: string): Promise<void> {
    try {
      await this.dbx.filesMoveV2({
        from_path: fromPath,
        to_path: toPath,
        autorename: true,
      });
    } catch (err: any) {
      console.error("Error moving Dropbox folder:", err);

      const e = new Error("Failed to move Dropbox folder");
      (e as any).status = err.status; // preserve the status code
      throw e; // throw a real Error instance
    }
  }

  async upload(files: File[], folderName: string): Promise<{ folder_path: string, share_link: string }> {
    try {
      let folderPath = `/fframess/${folderName}`;
      let count = 0;

      // Try to create a unique folder if it already exists
      while (await this.folderExists(folderPath)) {
        count++;
        folderPath = `/fframess/${folderName}-${count}`;
      }

      // Create the folder
      await this.dbx.filesCreateFolderV2({
        path: folderPath,
        autorename: false, // already ensured uniqueness
      });

      // Upload in batches of UPLOAD_BATCH_SIZE
      for (let i = 0; i < files.length; i += UPLOAD_BATCH_SIZE) {
        const batch = files.slice(i, i + UPLOAD_BATCH_SIZE);
        await Promise.all(batch.map(async (file) =>
          this.uploadFile(folderPath, file.name, new Uint8Array(await file.arrayBuffer()))
        ));
        // Optional small delay between batches
        await new Promise(r => setTimeout(r, 500));
      }

      // Create shared link
      const sharedLinkResponse = await this.dbx.sharingCreateSharedLinkWithSettings({
        path: folderPath,
        settings: {
          requested_visibility: "public" as unknown as sharing.RequestedVisibility,
        },
      });

      return { folder_path: folderPath, share_link: sharedLinkResponse.result.url };
    } catch (error: any) {
      console.error("Dropbox upload error:", error);
      const e = new Error("Failed to upload folder to Dropbox");
      (e as any).status = error.status;
      throw e;
    }
  }


  async createSharedLink(path: string): Promise<string> {
    try {
      const response = await this.dbx.sharingCreateSharedLinkWithSettings({
        path,
        settings: {
          requested_visibility:
            "public" as unknown as sharing.RequestedVisibility,
        },
      });

      return response.result.url;
    } catch (error) {
      console.error("Error creating shared link:", error);
      throw error;
    }
  }

  async listFiles(
    folderPath: string
  ): Promise<{ name: string; preview_url: string; thumbnail_url: string }[]> {
    try {
      const response = await this.dbx.filesListFolder({ path: folderPath });

      const imageFiles = response.result.entries.filter(
        (entry) =>
          entry[".tag"] === "file" &&
          /\.(jpg|jpeg|png|gif|webp)$/i.test(entry.name)
      );
      const filesWithLinks = await Promise.all(
        imageFiles.map(async (file) => {
          // Determine if we can generate a Dropbox thumbnail
          const getThumbnailFormat = (filename: string): "jpeg" | "png" | null => {
            const match = filename.match(/\.(\w+)$/);
            if (!match) return null;

            const ext = match[1].toLowerCase();
            if (ext === "jpeg" || ext === "jpg") return "jpeg";
            if (ext === "png") return "png";
            return null; // unsupported
          };

          const format = getThumbnailFormat(file.name);

          // Full preview link
          const linkRes = await this.dbx.filesGetTemporaryLink({
            path: file.path_lower!,
          });

          let thumbnail_url: string;

          if (format) {
            // Supported format → generate thumbnail
            const thumbnailRes = await this.dbx.filesGetThumbnailV2({
              resource: { ".tag": "path", path: file.path_lower! },
              format: { ".tag": format },
              size: { ".tag": "w2048h1536" },
            });

            const thumbnailBase64 = Buffer.from(
              (thumbnailRes.result as any).fileBinary,
              "binary"
            ).toString("base64");

            const meta = Buffer.from(file.name).toString("base64");
            thumbnail_url = `data:image/${format};name=${meta};base64,${thumbnailBase64}`;
          } else {
            // Unsupported format → fallback to original file link
            thumbnail_url = linkRes.result.link;
          }

          return {
            name: file.name,
            preview_url: linkRes.result.link,
            thumbnail_url,
          };
        })
      );

      return filesWithLinks;
    } catch (error) {
      throw error;
    }
  }

  async refreshDropboxToken(user: User) {
    try {
      if (!user.dropbox?.refresh_token) throw new Error("No refresh token for user");
      if (!process.env.EXPRESS_DROPBOX_CLIENT_ID || !process.env.EXPRESS_DROPBOX_CLIENT_SECRET) {
        throw new Error("Dropbox client ID or secret missing");
      }
      if (!USERS_TABLE) throw new Error("USERS_TABLE not set");

      const res = await axios.post(
        "https://api.dropbox.com/oauth2/token",
        qs.stringify({
          refresh_token: user.dropbox.refresh_token,
          grant_type: "refresh_token",
          client_id: process.env.EXPRESS_DROPBOX_CLIENT_ID,
          client_secret: process.env.EXPRESS_DROPBOX_CLIENT_SECRET,
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      const accessToken = res.data.access_token;
      if (!accessToken) throw new Error("Failed to obtain new Dropbox access token");

      this.dbx = new Dropbox({
        accessToken,
        fetch,
      });

      await client.send(
        new UpdateItemCommand({
          TableName: USERS_TABLE,
          Key: marshall({ user_id: user.user_id }),
          UpdateExpression: "SET dropbox.access_token = :t",
          ExpressionAttributeValues: marshall({ ":t": accessToken }),
        })
      );

      return accessToken;
    } catch (err: any) {
      console.error("Error refreshing Dropbox token:", err.response?.data || err.message || err);
      throw err; // re-throw so the caller knows it failed
    }
  }

  async deleteFolder(folderPath: string): Promise<void> {
    try {
      await this.dbx.filesDeleteV2({ path: folderPath });
    } catch (err: any) {
      console.error("Error deleting Dropbox folder:", err);

      if (err?.error?.error_summary?.includes("path/not_found")) {
        return;
      }

      const e = new Error("Failed to delete Dropbox folder");
      (e as any).status = err.status; // preserve the status code
      throw e; // throw a real Error instance
    }
  }

  async getStorageSpaceUsage(): Promise<{ used: number; allocated: number; used_percent: number }> {
    try {
      const res = await this.dbx.usersGetSpaceUsage();

      const used = res.result.used;
      let allocated = 0;

      const allocation = res.result.allocation as users.SpaceAllocation;

      if (allocation[".tag"] === "individual") {
        const individual = allocation as users.SpaceAllocationIndividual;
        allocated = individual.allocated;
      } else if (allocation[".tag"] === "team") {
        const team = allocation as users.SpaceAllocationTeam;
        allocated = team.allocated;
      }

      return {
        used,
        allocated,
        used_percent: allocated > 0 ? (used / allocated) * 100 : 0,
      };
    } catch (err: any) {
      console.error("Error getting Dropbox storage:", err);

      const e = new Error("Failed to fetch Dropbox storage info");
      (e as any).status = err.status; // preserve the status code
      throw e; // throw a real Error instance
    }
  }

  async getUserInfo(): Promise<{ email: string; first_name: string; last_name: string; account_id: string }> {
    try {
      const res = await this.dbx.usersGetCurrentAccount();

      const { email, name, account_id } = res.result;
      const first_name = name.given_name;
      const last_name = name.surname;

      return { email, first_name, last_name, account_id };
    } catch (err: any) {
      console.error("Error fetching Dropbox user info:", err);

      const e = new Error("Failed to fetch Dropbox user info");
      (e as any).status = err.status; // preserve the status code
      throw e; // throw a real Error instance    
    }
  }

  async uploadFile(
    folderPath: string,
    fileName: string,
    buffer: Buffer | Uint8Array,
  ): Promise<{ path: string; id: string }> {
    try {
      const path = `${folderPath}/${fileName}`;
      let uploaded = false;
      let result: files.FileMetadata | null = null;

      while (!uploaded) {
        try {
          const res = await this.dbx.filesUpload({
            path,
            contents: buffer,
            mode: "add" as unknown as files.WriteMode,
            autorename: true,
            mute: false,
          });
          result = res.result;
          uploaded = true;
        } catch (err: any) {
          if (err.status === 429 && err?.error?.error?.retry_after) {
            const waitMs = (err.error.error.retry_after + 1) * 1000;
            console.warn(`Rate limit hit, retrying after ${waitMs} ms`);
            await new Promise((r) => setTimeout(r, waitMs));
          } else {
            console.error("Dropbox uploadFile error:", err);

            const e = new Error("Failed to upload file to Dropbox");
            (e as any).status = err.status; // preserve the status code
            throw e; // throw a real Error instance
          }
        }
      }

      return {
        path,
        id: result!.id,
      };
    } catch (err: any) {
      console.error("Dropbox uploadFile outer error:", err);
      throw err;
    }
  }

  async deleteFile(folderPath: string, fileName: string): Promise<void> {
    const path = `${folderPath}/${fileName}`;
    try {
      await this.dbx.filesDeleteV2({ path });
    } catch (err: any) {
      // If file not found, consider it already deleted
      if (err?.error?.error_summary?.includes("path/not_found")) {
        console.warn(`File not found in Dropbox, skipping delete: ${path}`);
        return;
      }

      console.error("Error deleting file from Dropbox:", err);

      const e = new Error("Failed to delete file from Dropbox");
      (e as any).status = err.status; // preserve the status code
      throw e; // throw a real Error instance   
    }
  }
}
