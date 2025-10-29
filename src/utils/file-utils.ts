import sharp from "sharp";
import fetch from "node-fetch";

/**
 * Compress and resize large images from a URL into thumbnails (max 1024x768)
 * @param imageUrl - URL of the input image
 * @returns ArrayBuffer of the generated thumbnail
 */
export async function createThumbnailFromURL(imageUrl: string): Promise<Buffer<ArrayBuffer>> {
  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/tiff",
    "image/heic",
    "image/heif",
  ];

  // Fetch the image
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);

  const contentType = res.headers.get("content-type");
  if (!contentType || !allowedTypes.includes(contentType.toLowerCase())) {
    throw new Error(`Unsupported file type: ${contentType}`);
  }

  const inputBuffer = Buffer.from(await res.arrayBuffer());

  // Resize and compress
  const resizedBuffer = await sharp(inputBuffer)
    .resize({ width: 1024, height: 768, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .withMetadata()
    .toBuffer();

  // Cast Node.js Buffer to Buffer<ArrayBuffer>
  return resizedBuffer as unknown as Buffer<ArrayBuffer>;
}
