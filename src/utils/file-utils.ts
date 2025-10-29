import fetch from "node-fetch";

export async function createThumbnailFromURL(imageUrl: string): Promise<Buffer> {
  const allowedTypes = [
    "image/jpeg", "image/png", "image/gif",
    "image/webp", "image/tiff", "image/heic", "image/heif",
  ];

  // Dynamically import the right sharp binary
  const sharp =
    process.platform === "linux"
      ? (await import("@img/sharp-linux-x64")).default
      : (await import("sharp")).default;

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
