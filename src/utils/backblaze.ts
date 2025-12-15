import B2 from "backblaze-b2";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { User } from "../types";
import { createThumbnailFromURL } from "./file-utils";

import dotenv from "dotenv"

dotenv.config()

const UPLOAD_BATCH_SIZE = 3;
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";
const B2_BUCKET_ID = process.env.EXPRESS_B2_BUCKET_ID!;

const client = new DynamoDBClient({
  region: process.env.AWS_REGION_CODE,
});

export class BackblazeService {
  private b2: B2 & { authorizationToken?: string };
  private bucketId: string;
  private userId: string | undefined;
  private tenantId: string | undefined;

  constructor(bucketId: string, userId: string, tenantId?: string) {
    if (!process.env.EXPRESS_B2_APP_KEY_ID || !process.env.EXPRESS_B2_APP_KEY) {
      throw new Error("Backblaze credentials missing");
    }

    this.bucketId = bucketId;
    this.b2 = new B2({
      applicationKeyId: process.env.EXPRESS_B2_APP_KEY_ID,
      applicationKey: process.env.EXPRESS_B2_APP_KEY,
    });

    this.userId = userId;
    this.tenantId = tenantId;
  }

  // ----------------------
  // Authorize B2 client
  // ----------------------
  public async authorize(): Promise<void> {
    try {
      await this.b2.authorize();
    } catch (err) {
      console.error("Backblaze B2 authorization failed:", err);
      throw new Error("Failed to authorize Backblaze B2");
    }
  }

  // -----------------------
  // Helper: full prefix
  // -----------------------
  private getPrefix(folderPath: string = ""): string {
    if (!this.userId) throw new Error("userId not set");
    if (this.tenantId) {
      return `tenant/${this.tenantId}/user/${this.userId}/${folderPath}`.replace(/\/+$/, ""); // remove trailing slash
    } else {
      return `user/${this.userId}/${folderPath}`.replace(/\/+$/, "");
    }
  }

  private getStoragePrefix(folderPath: string = ""): string {
    if (!this.userId) throw new Error("userId not set");

    let basePath: string;
    if (this.tenantId) {
      basePath = `tenant/${this.tenantId}`;
    } else {
      basePath = `user/${this.userId}`;
    }

    return folderPath ? `${basePath}/${folderPath}` : basePath;
  }

  async folderExists(folderName: string): Promise<boolean> {
    try {
      const resp = await this.b2.listFileNames({
        bucketId: this.bucketId,
        prefix: this.getPrefix(folderName) + "/",
        maxFileCount: 1,
        startFileName: "",
        delimiter: "",
      });

      return resp.data.files.length > 0;
    } catch (err) {
      console.error("Error checking B2 folder existence:", err);
      throw new Error("Failed to check B2 folder existence");
    }
  }

  async upload(files: File[], folderName: string): Promise<{ folder_path: string; share_link: string }> {
    await this.authorize();

    let folderPath = folderName;
    let count = 0;

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
        fileName: `${this.getPrefix(folderPath)}/${file.name}`,
        data: fileBuffer as Buffer,
      });
    };

    for (let i = 0; i < files.length; i += UPLOAD_BATCH_SIZE) {
      const batch = files.slice(i, i + UPLOAD_BATCH_SIZE);
      await Promise.all(batch.map(uploadFile));
    }

    const shareLink = `https://f003.backblazeb2.com/file/${process.env.EXPRESS_B2_BUCKET_NAME}/${this.getPrefix(folderPath)}/`;

    return { folder_path: folderPath, share_link: shareLink };
  }

  async listFiles(folderPath: string) {
    await this.authorize();

    const resp = await this.b2.listFileNames({
      bucketId: this.bucketId,
      prefix: this.getPrefix(folderPath) + "/",
      maxFileCount: 1000,
      startFileName: "",
      delimiter: "",
    });

    const filesWithLinks = await Promise.all(
      resp.data.files.map(async (file: any) => {
        const authResp = await this.b2.getDownloadAuthorization({
          bucketId: this.bucketId,
          fileNamePrefix: file.fileName,
          validDurationInSeconds: 60 * 60, // 1 hour
        });

        const previewUrl =
          `https://f003.backblazeb2.com/file/${process.env.EXPRESS_B2_BUCKET_NAME}/${file.fileName}` +
          `?Authorization=${authResp.data.authorizationToken}`;
          
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
      prefix: this.getPrefix(folderPath) + "/",
      maxFileCount: 1000,
      startFileName: "",
      delimiter: "",
    });

    await Promise.all(
      resp.data.files.map(async (file: any) => {
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
      prefix: this.getPrefix(filePath),
      maxFileCount: 1,
      startFileName: "",
      delimiter: "/",
    });

    if (resp.data.files.length === 0) return;

    await this.b2.deleteFileVersion({
      fileName: resp.data.files[0].fileName,
      fileId: resp.data.files[0].fileId,
    });
  }

  async getStorageSpaceUsage(allocated: number = Infinity) {
    await this.authorize();
    let totalUsed = 0;
    let marker: string | undefined = undefined;
    const prefix = this.getStoragePrefix(); // user folder or tenant/user folder

    do {
      const resp = await this.b2.listFileNames({
        bucketId: this.bucketId,
        maxFileCount: 1000,
        startFileName: marker || "",
        prefix,
        delimiter: "",
      });

      totalUsed += resp.data.files.reduce((acc: any, file: any) => acc + (file.size || 0), 0);
      marker = resp.data.nextFileName;
    } while (marker);

    const usedPercent = allocated === Infinity ? 0 : (totalUsed / allocated) * 100;

    return {
      used: totalUsed,
      allocated,
      used_percent: Math.round(usedPercent * 100) / 100,
    };
  }


  // ----------------------
  // Copy a file via B2 API
  // ----------------------
  private async copyFileB2(sourceFileId: string, destinationFileName: string) {
    if (!this.b2.authorizationToken) {
      throw new Error("B2 client not authorized");
    }

    const res = await fetch("https://api.backblazeb2.com/b2api/v2/b2_copy_file", {
      method: "POST",
      headers: {
        Authorization: this.b2.authorizationToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceFileId,
        destinationBucketId: this.bucketId,
        destinationFileName,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`B2 copyFile failed: ${res.status} ${text}`);
    }

    return res.json();
  }

  // ----------------------
  // Move folder (copy then delete)
  // ----------------------
  public async moveFolder(oldFolderPath: string, newFolderPath: string) {
    await this.authorize();

    const oldPrefix = this.getStoragePrefix(oldFolderPath) + "/";
    const newPrefix = this.getStoragePrefix(newFolderPath) + "/";

    const files = await this.listFiles(oldFolderPath);

    // Copy files to new folder
    for (const file of files) {
      const newFileName = file.fileName.replace(oldPrefix, newPrefix);
      await this.copyFileB2(file.fileId, newFileName);
    }

    // Delete old files
    await Promise.all(
      files.map((file) => this.b2.deleteFileVersion({ fileName: file.fileName, fileId: file.fileId }))
    );
  }

  public async createThumbnailFromB2File(
    fileName: string
  ): Promise<Buffer> {
    await this.authorize()

    let sharp = require("sharp")

    // Download file via B2 API
    const res = await this.b2.downloadFileByName({
      bucketName: process.env.EXPRESS_B2_BUCKET_NAME!,
      fileName,
      responseType: "arraybuffer",
    });


    const buffer = Buffer.from(res.data as ArrayBuffer);

    return await sharp(buffer)
      .resize({
        width: 1024,
        height: 768,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .withMetadata()
      .toBuffer();
  }
}

