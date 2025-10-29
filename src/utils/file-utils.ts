import fetch from "node-fetch";
import gm from "gm";

export async function createThumbnailFromURL(imageUrl: string): Promise<Buffer<ArrayBuffer>> {
  const allowedTypes = [
    "image/jpeg", "image/png", "image/gif",
    "image/webp", "image/tiff", "image/heic", "image/heif",
  ];

  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);

  const contentType = res.headers.get("content-type")?.toLowerCase();
  if (!contentType || !allowedTypes.includes(contentType))
    throw new Error(`Unsupported file type: ${contentType}`);

  const inputBuffer = Buffer.from(await res.arrayBuffer());

  return new Promise((resolve, reject) => {
    gm(inputBuffer)
      .resize(1024, 768, ">") // fit inside 1024x768 without enlarging
      .quality(80) // JPEG quality
      .toBuffer("JPEG", (err, buffer) => {
        if (err) return reject(err);
        resolve(buffer as Buffer<ArrayBuffer>);
      });
  })
}
