import fetch from "node-fetch";
import gm from "gm";
import { promisify } from "util";

export async function createThumbnailFromURL(imageUrl: string): Promise<Buffer> {
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

  // gm uses callback style, wrap it in a Promise
  const toBufferAsync = promisify(gm(inputBuffer).resize(1024, 768, ">").toBuffer.bind(gm(inputBuffer)));

  try {
    const outputBuffer = await toBufferAsync("JPEG");
    return outputBuffer;
  } catch (err) {
    throw new Error(`Failed to process image with gm: ${err}`);
  }
}
