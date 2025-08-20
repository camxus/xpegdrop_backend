import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type ImageWithLocation = {
  s3location: {
    bucket: string;
    key: string;
  };
  [key: string]: any;
};

export const getSignedImage = async (client: any, image: ImageWithLocation) => {
  if (!image?.s3location?.bucket || !image?.s3location?.key) {
    console.warn("Skipping image with invalid s3location:", image);
    return undefined;
  }
  try {
    const command: any = new GetObjectCommand({
      Bucket: image.s3location.bucket,
      Key: image.s3location.key,
    });
    const url = await getSignedUrl(client, command, { expiresIn: 3600 });
    return url;
  } catch (error) {
    console.error("Error getting signed URL for image:", image, error);
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
  key: string,
  buffer: any
): Promise<{ bucket: string; key: string }> => {
  const bucketName = process.env.S3_APP_BUCKET!

  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentEncoding: "base64",
      ContentType: "image/jpeg", // You can customize based on actual image type
      ACL: "public-read", // Optional, adjust based on your needs
    })
  );

  return { bucket: bucketName, key };
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
        Bucket: s3location.bucket,
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
  if (!location.bucket || !location.key) {
    throw new Error("Invalid S3 location");
  }

  try {
    const command = new GetObjectCommand({
      Bucket: location.bucket,
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