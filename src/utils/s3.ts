import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Location } from "../types";


export const getSignedImage = async (client: any, s3Location: S3Location) => {
  if (!s3Location?.bucket || !s3Location?.key) {
    console.warn("Skipping image with invalid s3location:", s3Location.key);
    return undefined;
  }
  try {
    const command: any = new GetObjectCommand({
      Bucket: s3Location.bucket,
      Key: s3Location.key,
    });
    const url = await getSignedUrl(client, command, { expiresIn: 3600 });
    return url;
  } catch (error) {
    console.error("Error getting signed URL for image:", s3Location.key, error);
    throw error;
  }
};

export const getItemImages = async (
  client: S3Client,
  item: Record<string, any>,
  itemKey: string
): Promise<Record<string, any>> => {
  const images = item[itemKey];

  // Handle empty or missing value
  if (!images) return item;

  // Helper to get signed URL for a single image

  if (Array.isArray(images)) {
    const itemImages = await Promise.all(
      images.map((image) => getSignedImage(client, image))
    );
    return { ...item, [itemKey]: itemImages };
  } else {
    // single image object
    const singleImage = await getSignedImage(client, images);
    return { ...item, [itemKey]: singleImage };
  }
};

export const saveItemImage = async (
  client: S3Client,
  bucket: string = process.env.EXPRESS_S3_APP_BUCKET!,
  key: string,
  buffer: any,
  isPublic = true
): Promise<{ bucket: string; key: string }> => {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentEncoding: "base64",
      ContentType: "image/jpeg", // You can customize based on actual image type
      ACL: isPublic ? "public-read" : undefined, // Optional, adjust based on your needs
    })
  );

  return { bucket, key };
};

export const copyItemImage = async (
  client: S3Client,
  source: { bucket: string; key: string },
  destination: { bucket: string; key: string }
): Promise<{ bucket: string; key: string }> => {
  try {
    await client.send(
      new CopyObjectCommand({
        CopySource: encodeURIComponent(`${source.bucket}/${source.key}`),
        Bucket: destination.bucket,
        Key: destination.key,
        ACL: "public-read", // optional, adjust as needed
      })
    );

    return { bucket: destination.bucket, key: destination.key };
  } catch (error) {
    console.error("Error copying S3 object:", source, destination, error);
    throw error;
  }
};

export const deleteItemImage = async (
  client: S3Client,
  s3location: { bucket: string; key: string },
): Promise<string> => {
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: s3location.bucket || process.env.EXPRESS_S3_TEMP_BUCKET,
        Key: s3location.key,
      })
    );

    return "successfully deleted Object";
  } catch (error) {
    console.error("Error deleting S3 object:", s3location, error);
    throw error;
  }
};

/**
 * Helper: convert S3 ReadableStream to Buffer
 */
const streamToBuffer = async (readableStream: any) => {
  const chunks: any[] = [];
  for await (const chunk of readableStream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/**
 * Get file from S3
 * @param client S3Client
 * @param location { bucket, key }
 * @returns { buffer: Buffer, file: File contentType: string }
 */
export const getItemFile = async (
  client: S3Client,
  location: { bucket: string; key: string }
) => {
  if (!location.key) {
    throw new Error("Invalid S3 location");
  }

  try {
    const command = new GetObjectCommand({
      Bucket: location.bucket || process.env.EXPRESS_S3_TEMP_BUCKET,
      Key: location.key,
    });

    const response = await client.send(command);

    // Convert ReadableStream to Buffer
    const buffer = await streamToBuffer(response.Body);

    const contentType = response.ContentType || "application/octet-stream";

    // Create a File object (from fetch-blob)
    const file = new File([buffer], location.key.split("/").pop()!, { type: contentType });

    return {
      buffer,
      file,
      contentType: response.ContentType || "application/octet-stream",
    };
  } catch (error) {
    console.error("Error getting S3 file:", location, error);
    throw error;
  }
};

export const s3ObjectExists = async (
  client: S3Client,
  bucket: string,
  key: string
): Promise<boolean> => {
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    return true; // exists
  } catch (err: any) {
    if (err.name === "NotFound") return false; // doesn't exist
    throw err; // some other error
  }
};