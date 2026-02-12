import B2 from "backblaze-b2";
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createThumbnailFromURL, transcodeVideoToMp4 } from "../utils/file-utils";

import dotenv from "dotenv"
import { getSignedImage, s3ObjectExists } from "../utils/s3";
import { S3Client } from "@aws-sdk/client-s3";

dotenv.config()

const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });
const THUMBNAILS_BUCKET = process.env.EXPRESS_S3_THUMBNAILS_BUCKET || "";

const UPLOAD_BATCH_SIZE = 3;
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";
const B2_BUCKET_NAME = process.env.EXPRESS_B2_BUCKET_NAME!;
const B2_TRANSCODED_MEDIA_BUCKET_ID = process.env.EXPRESS_B2_TRANSCODED_MEDIA_BUCKET_ID!;
const B2_TRANSCODED_MEDIA_BUCKET_NAME = process.env.EXPRESS_B2_TRANSCODED_MEDIA_BUCKET_NAME!;

const client = new DynamoDBClient({
  region: process.env.AWS_REGION_CODE,
});

const imageRegex = /\.(jpg|jpeg|png|gif|webp|tiff|tif|heic|heif)$/i;
const videoRegex = /\.(mp4|mov|webm|mkv|m4v)$/i;

type B2File = {
  fileId: string;
  fileName: string;
  accountId: string;
  bucketId: string;
  contentLength: number;
  contentSha1: string;
  contentType: string;
  fileInfo: Record<string, string>;
  uploadTimestamp: number;
  action: string;
  serverSideEncryption?: string;
}
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
  public getPrefix(folderPath: string = ""): string {
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

  // ----------------------
  // Upload a single file
  // ----------------------
  public async uploadFile(file: File, folderPath: string): Promise<string> {
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const uploadFileName = `${this.getPrefix(folderPath)}/${file.name}`;

    const videoTypes = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];

    // ---- Original upload ----
    const originalUpload = (async () => {
      const uploadUrlResp = await this.b2.getUploadUrl({ bucketId: this.bucketId });
      await this.b2.uploadFile({
        uploadUrl: uploadUrlResp.data.uploadUrl,
        uploadAuthToken: uploadUrlResp.data.authorizationToken,
        fileName: uploadFileName,
        data: fileBuffer,
      });
    })();

    // ---- Transcode + upload (conditional) ----
    const transcodeUpload =
      videoTypes.includes(file.type.toLowerCase()) && this.userId
        ? (async () => {
          const transcodedService = new BackblazeService(
            B2_TRANSCODED_MEDIA_BUCKET_ID!,
            this.userId!,
            this.tenantId
          );

          const transcodedFileName = `${this.getPrefix(folderPath)}/${file.name.replace(/\.\w+$/, ".mp4")}`;
          await transcodedService.b2.authorize();

          const existingFiles = await transcodedService.listFiles(folderPath);
          const exists = existingFiles.some((f) => f.name === transcodedFileName);

          if (exists) await transcodedService.deleteFile(folderPath, transcodedFileName);

          const transcodedBuffer = await transcodeVideoToMp4(fileBuffer);

          const uploadUrlResp = await transcodedService.b2.getUploadUrl({
            bucketId: transcodedService.bucketId,
          });

          await transcodedService.b2.uploadFile({
            uploadUrl: uploadUrlResp.data.uploadUrl,
            uploadAuthToken: uploadUrlResp.data.authorizationToken,
            fileName: transcodedFileName,
            data: transcodedBuffer,
          });
        })()
        : Promise.resolve();

    await Promise.all([originalUpload, transcodeUpload]);

    return uploadFileName; // return full path for this file
  }

  // ----------------------
  // Upload multiple files
  // ----------------------
  public async upload(files: File[], folderName: string): Promise<{ folder_path: string; share_link: string; filePaths: string[] }> {
    await this.authorize();

    let folderPath = folderName;
    let count = 0;

    // Ensure unique folder name
    while (await this.folderExists(folderPath)) {
      count++;
      folderPath = `${folderName}-${count}`;
    }

    const filePaths: string[] = [];

    for (let i = 0; i < files.length; i += UPLOAD_BATCH_SIZE) {
      const batch = files.slice(i, i + UPLOAD_BATCH_SIZE);
      const batchPaths = await Promise.all(batch.map((file) => this.uploadFile(file, folderPath)));
      filePaths.push(...batchPaths);
    }

    const shareLink = `https://f003.backblazeb2.com/file/${B2_BUCKET_NAME}/${this.getPrefix(folderPath)}`;
    console.log("Share link:", shareLink);

    return { folder_path: folderPath, share_link: shareLink, filePaths };
  }

  private async listFilesRaw(folderPath: string): Promise<B2File[]> {
    await this.authorize();

    const resp = await this.b2.listFileNames({
      bucketId: this.bucketId,
      prefix: this.getPrefix(folderPath) + "/",
      maxFileCount: 1000,
      startFileName: "",
      delimiter: ""
    });

    return resp.data.files;
  }

  async listFiles(folderPath: string) {

    await this.authorize(); // authorize B2

    const resp = await this.b2.listFileNames({
      bucketId: this.bucketId,
      prefix: this.getPrefix(folderPath) + "/",
      maxFileCount: 1000,
      startFileName: "",
      delimiter: "",
    });

    type FileWithLinks = {
      id: string
      name: string;
      type: "image" | "video" | "other";
      preview_url: string;
      full_file_url: string;
      thumbnail: Buffer;
      thumbnail_url?: string;
    };

    const filesWithLinks: FileWithLinks[] = await Promise.all(
      resp.data.files.map(async (file: B2File) => {
        const fileName = file.fileName.split("/").pop()!;

        // Temporary auth token for main bucket
        const authResp = await this.b2.getDownloadAuthorization({
          bucketId: this.bucketId,
          fileNamePrefix: file.fileName,
          validDurationInSeconds: 60 * 60, // 1 hour
        });

        let fullFileUrl = `https://f003.backblazeb2.com/file/${B2_BUCKET_NAME}/${file.fileName}` +
          `?Authorization=${authResp.data.authorizationToken}`;

        let previewUrl: string;
        let thumbnail: Buffer = Buffer.from("");
        let thumbnailUrl: string | undefined;

        // Determine file type
        const type: FileWithLinks["type"] = videoRegex.test(fileName)
          ? "video"
          : imageRegex.test(fileName)
            ? "image"
            : "other";

        if (type === "video" && this.userId) {
          // Video → preview is from transcoded bucket
          const transcodedService = new BackblazeService(
            B2_TRANSCODED_MEDIA_BUCKET_ID!,
            this.userId,
            this.tenantId
          );

          const transcodedFiles = await transcodedService.listFilesRaw(folderPath);
          const transcodedFile = transcodedFiles.find(
            (f) => f.fileName.split("/").pop() === fileName.replace(/\.\w+$/, ".mp4")
          );

          if (transcodedFile) {
            const authTranscoded = await transcodedService.b2.getDownloadAuthorization({
              bucketId: transcodedService.bucketId,
              fileNamePrefix: transcodedFile.fileName,
              validDurationInSeconds: 60 * 60,
            });

            previewUrl = `https://f003.backblazeb2.com/file/${B2_TRANSCODED_MEDIA_BUCKET_NAME}/${transcodedFile.fileName}` +
              `?Authorization=${authTranscoded.data.authorizationToken}`;
          } else {
            previewUrl = fullFileUrl;
          }

         if (await s3ObjectExists(s3Client, THUMBNAILS_BUCKET, file.fileName)) {
              thumbnailUrl = await getSignedImage(s3Client, {
                bucket: THUMBNAILS_BUCKET,
                key: file.fileName,
              });
            } else {
              thumbnail = await createThumbnailFromURL(previewUrl);
            }
        } else {
          // Image / other → preview & download are the same
          previewUrl = fullFileUrl;

          if (type === "image") {
            if (await s3ObjectExists(s3Client, THUMBNAILS_BUCKET, file.fileName)) {
              thumbnailUrl = await getSignedImage(s3Client, {
                bucket: THUMBNAILS_BUCKET,
                key: file.fileName,
              });
            } else {
              thumbnail = await createThumbnailFromURL(previewUrl);
            }
          }
        }

        return {
          id: file.fileId,
          path: file.fileName,
          name: fileName,
          type,
          preview_url: previewUrl,
          thumbnail,
          thumbnail_url: thumbnailUrl,
          full_file_url: fullFileUrl,
        };
      })
    );

    return filesWithLinks;
  }

  async deleteFolder(folderPath: string) {
    await this.authorize();

    // Delete from main bucket
    const resp = await this.b2.listFileNames({
      bucketId: this.bucketId,
      prefix: this.getPrefix(folderPath) + "/",
      maxFileCount: 1000,
      startFileName: "",
      delimiter: "",
    });

    await Promise.all(
      resp.data.files.map(async (file: B2File) => {
        try {
          await this.b2.deleteFileVersion({
            fileName: file.fileName,
            fileId: file.fileId,
          });

          const fileName = file.fileName.split("/").pop()!;

          // If video → delete from transcoded bucket as well
          if (videoRegex.test(fileName) && this.userId) {
            const transcodedService = new BackblazeService(
              B2_TRANSCODED_MEDIA_BUCKET_ID!,
              this.userId,
              this.tenantId
            );

            const transcodedFiles = await transcodedService.listFiles(folderPath);
            const transcodedFile = transcodedFiles.find(
              (f) => f.name === fileName.replace(/\.\w+$/, ".mp4")
            );

            if (transcodedFile) {
              await transcodedService.b2.deleteFileVersion({
                fileName: transcodedFile.name,
                fileId: transcodedFile.id,
              });
            }
          }
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

    const file = resp.data.files[0];
    await this.b2.deleteFileVersion({
      fileName: file.fileName,
      fileId: file.fileId,
    });

    // If video → delete from transcoded bucket
    if (videoRegex.test(fileName) && this.userId) {
      const transcodedService = new BackblazeService(
        B2_TRANSCODED_MEDIA_BUCKET_ID!,
        this.userId,
        this.tenantId
      );

      const transcodedFiles = await transcodedService.listFilesRaw(folderPath);
      const transcodedFile = transcodedFiles.find(
        (f) => f.fileName.split("/").pop() === fileName.replace(/\.\w+$/, ".mp4")
      );

      if (transcodedFile) {
        await transcodedService.b2.deleteFileVersion({
          fileName: transcodedFile.fileName,
          fileId: transcodedFile.fileId,
        });
      }
    }
  }

  async getStorageSpaceUsage(membershipId?: string) {
    await this.authorize();
    let totalUsed = 0;
    let marker: string | undefined = undefined;
    const prefix = this.getStoragePrefix(); // user folder or tenant/user folder

    let allocated = 0;

    if (!this.tenantId) {
      if (!membershipId) {
        // Fetch user from DynamoDB
        const response = await client.send(
          new GetItemCommand({
            TableName: USERS_TABLE,
            Key: marshall({ user_id: this.userId }),
          })
        );

        if (!response.Item) {
          throw new Error("User not found")
        }

        const user = unmarshall(response.Item);

        membershipId = user.membership?.membership_id
      }

      // Set storage allocation based on membership
      if (membershipId?.includes("artist")) {
        allocated = 2 * 1024 ** 3; // 2 GB
      } else if (membershipId?.includes("pro")) {
        allocated = 500 * 1024 ** 3; // 500 GB
      } else if (membershipId?.includes("agency")) {
        allocated = 2000 * 1024 ** 3; // 2 TB
      }
    }

    try {
      do {
        const resp = await this.b2.listFileNames({
          bucketId: this.bucketId,
          maxFileCount: 1000,
          startFileName: marker || "",
          prefix,
          delimiter: "",
        });


        totalUsed += resp.data.files.reduce((acc: any, file: any) => acc + (file.contentLength || 0), 0);
        marker = resp.data.nextFileName;
      } while (marker);
    } catch (err: any) {
      if (err?.status === 404) {
        // Bucket or prefix not found, return 0 usage
        return {
          used: 0,
          allocated,
          used_percent: 0,
        };
      }
      // Re-throw other errors
      throw err;
    }

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
  private async copyFileB2(sourceFileId: string, newFileName: string) {
    if (!this.b2.authorizationToken) {
      throw new Error("B2 client not authorized");
    }

    const res = await fetch(
      "https://api003.backblazeb2.com/b2api/v4/b2_copy_file",
      {
        method: "POST",
        headers: {
          Authorization: this.b2.authorizationToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourceFileId,
          destinationBucketId: this.bucketId,
          fileName: newFileName,
          metadataDirective: "COPY",
        }),
      }
    );

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
      const newFileName = file.name.replace(oldPrefix, newPrefix);
      await this.copyFileB2(file.id, newPrefix + newFileName);
    }

    // Delete old files
    await Promise.all(
      files.map((file) => this.b2.deleteFileVersion({ fileName: oldPrefix + file.name, fileId: file.id }))
    );
  }
}

