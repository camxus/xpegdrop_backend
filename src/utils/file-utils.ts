import fetch from "node-fetch";
import sharp from "sharp"
const allowedTypes = [
  "image/jpeg", "image/png", "image/gif",
  "image/webp", "image/tiff", "image/heic", "image/heif",
];

export async function createThumbnailFromURL(imageUrl: string): Promise<Buffer> {

  // Dynamically import the right sharp binary

  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);

  const contentType = res.headers.get("content-type")?.toLowerCase();
  if (!contentType || !allowedTypes.includes(contentType))
    throw new Error(`Unsupported file type: ${contentType}`);

  const inputBuffer = Buffer.from(await res.arrayBuffer());

  return await sharp(inputBuffer)
    .resize({ width: 1024, height: 768, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .withMetadata()
    .toBuffer()
}

export async function createThumbnailFromFile(file: File): Promise<Buffer> {
  if (!allowedTypes.includes(file.type.toLowerCase())) {
    throw new Error(`Unsupported file type: ${file.type}`);
  }

  // Read file into buffer
  const arrayBuffer = await file.arrayBuffer();
  const inputBuffer = Buffer.from(arrayBuffer);

  // Resize and convert
  return await sharp(inputBuffer)
    .resize({ width: 1024, height: 768, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .withMetadata()
    .toBuffer();
}
