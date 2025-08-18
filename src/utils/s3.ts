import {
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
  const bucketName = process.env.S3_APP_BUCKET || "pegdrop-app";

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
