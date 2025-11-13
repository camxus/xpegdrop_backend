import B2 from "backblaze-b2";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { User } from "../types";
import { createThumbnailFromURL } from "./file-utils";

const UPLOAD_BATCH_SIZE = 3;
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";

const client = new DynamoDBClient({
  region: process.env.AWS_REGION_CODE,
});

export class BackblazeService {
  private b2: B2;
  private bucketId: string;

  constructor(bucketId: string) {
    if (!process.env.B2_APP_KEY_ID || !process.env.B2_APP_KEY) {
      throw new Error("Backblaze credentials missing");
    }

    this.bucketId = bucketId;

    this.b2 = new B2({
      applicationKeyId: process.env.B2_APP_KEY_ID,
      applicationKey: process.env.B2_APP_KEY,
    });
  }

  async authorize() {
    await this.b2.authorize();
  }

  async folderExists(folderName: string): Promise<boolean> {
    try {
      const resp = await this.b2.listFileNames({
        bucketId: this.bucketId,
        prefix: folderName + "/",
        maxFileCount: 1,
        // startFileName: "",
        // delimiter: "",
      });

      return resp.data.files.length > 0;
    } catch (err) {
      console.error("Error checking B2 folder existence:", err);
      throw new Error("Failed to check B2 folder existence");
    }
  }

  async upload(files: File[], folderName: string): Promise<{ folder_path: string; share_link: string }> {
    await this.authorize();

    let folderPath = `${folderName}`;
    let count = 0;

    // Ensure unique folder name
    while (await this.folderExists(folderPath)) {
      count++;
      folderPath = `${folderName}-${count}`;
    }

    const uploadFile = async (file: File) => {
      const uploadUrlResp = await this.b2.getUploadUrl({ bucketId: this.bucketId });
      const fileBuffer = new Uint8Array(await file.arrayBuffer());

      await this.b2.uploadFile({
        uploadUrl: uploadUrlResp.data.uploadUrl,
        uploadAuthToken: uploadUrlResp.data.authorizationToken,
        fileName: `${folderPath}/${file.name}`,
        data: fileBuffer as Buffer,
      });
    };

    // Upload in batches
    for (let i = 0; i < files.length; i += UPLOAD_BATCH_SIZE) {
      const batch = files.slice(i, i + UPLOAD_BATCH_SIZE);
      await Promise.all(batch.map(uploadFile));
    }

    // Backblaze doesn’t have native "share links"; you usually serve files via public bucket URL or generate temporary URLs
    const shareLink = `https://f002.backblazeb2.com/file/${process.env.B2_BUCKET_NAME}/${folderPath}/`;

    return { folder_path: folderPath, share_link: shareLink };
  }

  async listFiles(folderPath: string): Promise<{ name: string; preview_url: string; thumbnail_url: string; thumbnail: any }[]> {
    await this.authorize();

    const resp = await this.b2.listFileNames({
      bucketId: this.bucketId,
      prefix: folderPath + "/",
      maxFileCount: 1000,
      // startFileName: "",
      // delimiter: "",
    });

    const filesWithLinks = await Promise.all(
      resp.data.files.map(async (file) => {
        const previewUrl = `https://f002.backblazeb2.com/file/${process.env.B2_BUCKET_NAME}/${file.fileName}`;
        let thumbnail = Buffer.from(""); // optional thumbnail
        let thumbnailUrl = "";

        thumbnail = await createThumbnailFromURL(previewUrl) as typeof thumbnail;

        return {
          name: file.fileName.split("/").pop()!,
          preview_url: previewUrl,
          thumbnail_url: thumbnailUrl,
          thumbnail,
        };
      })
    );

    return filesWithLinks;
  }

  async deleteFolder(folderPath: string) {
    await this.authorize();

    const resp = await this.b2.listFileNames({
      bucketId: this.bucketId,
      prefix: folderPath + "/",
      maxFileCount: 1000,
      // startFileName: "",
      // delimiter: "",
    });

    await Promise.all(
      resp.data.files.map(async (file) => {
        try {
          await this.b2.deleteFileVersion({
            fileName: file.fileName,
            fileId: file.fileId,
          });
        } catch (err) {
          console.error("Error deleting B2 file:", file.fileName, err);
        }
      })
    );
  }

  async deleteFile(folderPath: string, fileName: string) {
    await this.authorize();

    const filePath = `${folderPath}/${fileName}`;
    const resp = await this.b2.listFileNames({
      bucketId: this.bucketId,
      prefix: filePath,
      maxFileCount: 1,
      // startFileName: "",
      // delimiter: "", 
    });

    if (resp.data.files.length === 0) return;

    await this.b2.deleteFileVersion({
      fileName: resp.data.files[0].fileName,
      fileId: resp.data.files[0].fileId,
    });
  }

  async getStorageSpaceUsage(): Promise<{ used: number; allocated: number; used_percent: number }> {
    // Backblaze doesn’t provide per-bucket allocation in the same way Dropbox does.
    // You can estimate used storage via listing files + summing sizes
    await this.authorize();
    let totalUsed = 0;
    let marker: string | undefined = undefined;

    do {
      const resp = await this.b2.listFileNames({
        bucketId: this.bucketId,
        maxFileCount: 1000,
        startFileName: marker || "",
        // prefix: "",
        // delimiter: ""
      });

      totalUsed += resp.data.files.reduce((acc: number, file) => acc + (file.size || 0), 0);
      marker = resp.data.nextFileName;
    } while (marker);

    return { used: totalUsed, allocated: Infinity, used_percent: 0 };
  }

  async uploadFile(folderPath: string, fileName: string, buffer: Buffer | Uint8Array) {
    await this.authorize();

    const uploadUrlResp = await this.b2.getUploadUrl({ bucketId: this.bucketId });

    const res = await this.b2.uploadFile({
      uploadUrl: uploadUrlResp.data.uploadUrl,
      uploadAuthToken: uploadUrlResp.data.authorizationToken,
      fileName: `${folderPath}/${fileName}`,
      data: buffer as Buffer,
    });

    return { path: `${folderPath}/${fileName}`, id: res.data.fileId };
  }

  async getUserInfo(): Promise<{ account_id: string }> {
    // Backblaze B2 doesn't have individual user accounts like Dropbox; only the application key identity
    return { account_id: process.env.B2_APP_KEY_ID! };
  }
}
