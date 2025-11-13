import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { Project, User } from "../../types";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { DropboxService } from "../dropbox";
import { getSignedImage, s3ObjectExists, saveItemImage } from "../s3";
import { S3Client } from "@aws-sdk/client-s3";


const client = new DynamoDBClient({ region: process.env.AWS_REGION_CODE });

const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });

const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "Users";


export const getProjectWithImages = async (project: Project, handle: string) => {
    // Fetch user from DynamoDB
    const userResponse = await client.send(
        new GetItemCommand({
            TableName: USERS_TABLE,
            Key: { user_id: { S: project.user_id } },
        })
    );

    if (!userResponse.Item) {
        throw new Error("User not found");
    }

    const user = unmarshall(userResponse.Item) as User;

    if (!user.dropbox?.access_token || !user.dropbox?.refresh_token) {
        throw new Error("User Dropbox tokens missing.");
    }

    if (!project.dropbox_folder_path) {
        throw new Error("Dropbox folder path missing.");
    }

    let dropboxAccessToken = user.dropbox.access_token;
    const dropboxService = new DropboxService(dropboxAccessToken);

    const resolveFiles = async (files: any[]) =>
        Promise.all(
            files.map(async (file) => {
                const projectName = project.name.toLowerCase().replace(/\s+/g, "-");
                const s3Key = `thumbnails/${handle}/${projectName}/${file.name}`;
                const bucketName = process.env.EXPRESS_S3_TEMP_BUCKET!;

                const exists = await s3ObjectExists(s3Client, bucketName, s3Key);
                const s3Location = exists
                    ? { bucket: bucketName, key: s3Key }
                    : await saveItemImage(s3Client, bucketName, s3Key, file.thumbnail, false);

                const thumbnailUrl = await getSignedImage(s3Client, s3Location);

                delete file.thumbnail;
                return { ...file, thumbnail_url: thumbnailUrl };
            })
        );

    let dropboxFiles: any[] = [];

    try {
        dropboxFiles = await dropboxService.listFiles(project.dropbox_folder_path);
        dropboxFiles = await resolveFiles(dropboxFiles);
    } catch (err: any) {
        const isUnauthorized = err.status === 401;

        if (isUnauthorized && user.dropbox.refresh_token) {
            await dropboxService.refreshDropboxToken(user);
            dropboxFiles = await dropboxService.listFiles(project.dropbox_folder_path);
            dropboxFiles = await resolveFiles(dropboxFiles);
        } else {
            console.error("Dropbox access failed:", err);
            throw new Error("Failed to access Dropbox files");
        }
    }

    const images = dropboxFiles.filter((file: any) =>
        /\.(jpg|jpeg|png|gif|webp|tiff|tif|heic|heif)$/i.test(file.name)
    );

    return {
        project: {
            ...project,
            share_url:
                (process.env.EXPRESS_PUBLIC_FRONTEND_URL || "") + project.share_url,
        },
        images,
    };
};

/**
 * Generates a tenant-specific URL by replacing the subdomain with the tenant handle
 * @param frontendUrl The base frontend URL (e.g., process.env.EXPRESS_PUBLIC_FRONTEND_URL)
 * @param handle The tenant's handle
 * @returns The full tenant URL
 */
export function getTenantUrl(frontendUrl: string | undefined, handle: string): string {
    if (!frontendUrl) throw new Error("Frontend URL not defined");
    if (!handle) throw new Error("Tenant handle not defined");

    const url = new URL(frontendUrl);
    const hostParts = url.hostname.split(".");

    // Remove existing subdomain if there are more than 2 parts
    if (hostParts.length > 2) {
        hostParts.shift();
    }

    // Prepend tenant handle as new subdomain
    const newHostname = `${handle}.${hostParts.join(".")}`;

    return `${url.protocol}//${newHostname}${url.pathname}`;
}
