import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Dropbox } from "../../sdk/dropbox";
import type { sharing, files } from "../../sdk/dropbox";
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
      throw { ...new Error("Failed to check Dropbox folder existence"), status: err.status };
    }
  }

  async upload(files: File[], folderName: string): Promise<{ folder_path: string, share_link: string }> {
    try {
      const folderPath = `/xpegdrop/${folderName}`;

      // Create folder
      if (!await this.folderExists(folderPath)) {
        await this.dbx.filesCreateFolderV2({
          path: folderPath,
          autorename: true,
        });
      }

      // Function to upload a single file with retry on 429
      const uploadFile = async (file: File) => {
        const arrayBuffer = await file.arrayBuffer();
        const contents = new Uint8Array(arrayBuffer);

        let uploaded = false;
        while (!uploaded) {
          try {
            await this.dbx.filesUpload({
              path: `${folderPath}/${file.name}`,
              contents,
              mode: "add" as unknown as files.WriteMode,
              autorename: false,
            });
            uploaded = true;
          } catch (err: any) {
            if (err.status === 429 && err?.error?.error?.retry_after) {
              const waitMs = (err.error.error.retry_after + 1) * 1000;
              console.warn(`Rate limit hit, retrying after ${waitMs} ms`);
              await new Promise((r) => setTimeout(r, waitMs));
            } else {
              throw err;
            }
          }
        }
      };

      // Upload in batches of UPLOAD_BATCH_SIZE
      for (let i = 0; i < files.length; i += UPLOAD_BATCH_SIZE) {
        const batch = files.slice(i, i + UPLOAD_BATCH_SIZE);
        await Promise.all(batch.map((file) => uploadFile(file)));
        // Optional small delay between batches to be extra safe
        await new Promise((r) => setTimeout(r, 500));
      }

      // Create shared link
      const sharedLinkResponse =
        await this.dbx.sharingCreateSharedLinkWithSettings({
          path: folderPath,
          settings: {
            requested_visibility:
              "public" as unknown as sharing.RequestedVisibility,
          },
        });

      return { folder_path: folderPath, share_link: sharedLinkResponse.result.url };
    } catch (error: any) {
      console.error("Dropbox upload error:", error);
      throw { ...new Error("Failed to upload folder to Dropbox"), status: error.status };
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
          // Full preview link
          const linkRes = await this.dbx.filesGetTemporaryLink({
            path: file.path_lower!,
          });

          // Thumbnail
          const thumbnailRes = await this.dbx.filesGetThumbnailV2({
            resource: { ".tag": "path", path: file.path_lower! },
            format: { ".tag": "jpeg" }, // or "png"
            size: { ".tag": "w2048h1536" }, // available sizes: w32h32, w64h64, w128h128, etc.
          });

          const thumbnailBase64 = Buffer.from(
            (thumbnailRes.result as any).fileBinary,
            "binary"
          ).toString("base64");
          const thumbnail_url = `data:image/jpeg;base64,${thumbnailBase64}`;

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
    const res = await axios.post(
      "https://api.dropbox.com/oauth2/token",
      qs.stringify({
        refresh_token: user.dropbox?.refresh_token,
        grant_type: "refresh_token",
        client_id: process.env.EXPRESS_DROPBOX_CLIENT_ID!,
        client_secret: process.env.EXPRESS_DROPBOX_CLIENT_SECRET!,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    this.dbx = new Dropbox({
      accessToken: res.data.access_token,
      fetch: fetch,
    });

    // TODO: persist new accessToken back to DynamoDB for future calls
    await client.send(
      new UpdateItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ user_id: user.user_id }),
        UpdateExpression: "SET dropbox.access_token = :t",
        ExpressionAttributeValues: marshall({ ":t": res.data.access_token }),
      })
    );

    return res.data.access_token as string;
  }
}
