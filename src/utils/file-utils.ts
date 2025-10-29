import fetch from "node-fetch";

export async function createThumbnailFromURL(imageUrl: string): Promise<Buffer> {
  const allowedTypes = [
    "image/jpeg", "image/png", "image/gif",
    "image/webp", "image/tiff", "image/heic", "image/heif",
  ];

  // Dynamically import the right sharp binary
  let sharp: typeof import("sharp");

  if (process.platform === "linux") {
    sharp = require("@img/sharp-linux-x64");
  } else {
    sharp = require("sharp");
  }

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
    .toBuffer();
}
