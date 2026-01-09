import fetch from "node-fetch";
import sharp from "sharp";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const allowedImageTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/tiff",
  "image/heic",
  "image/heif",
];

const allowedVideoTypes = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
];

/**
 * Create video thumbnail in Lambda using ffmpeg layer
 */
async function createVideoThumbnailFromBuffer(buffer: Buffer): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "thumb-"));
  const inputPath = path.join(tmpDir, "input.video");
  const outputPath = path.join(tmpDir, "thumb.jpg");

  try {
    await fs.writeFile(inputPath, buffer);

    // FFmpeg path in Lambda layer
    const ffmpegPath = "/opt/bin/ffmpeg";

    await execFileAsync(ffmpegPath, [
      "-y",
      "-i", inputPath,
      "-ss", "00:00:00.100", // skip black first frame
      "-frames:v", "1",
      "-vf", "scale='min(1024,iw)':'min(768,ih)':force_original_aspect_ratio=decrease",
      outputPath,
    ]);

    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Transcode video buffer to a smaller MP4
 */
export async function transcodeVideoToMp4(
  buffer: Buffer,
  maxWidth = 1024,
  maxHeight = 768,
  bitrate = "1000k" // target bitrate
): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-"));
  const inputPath = path.join(tmpDir, "input.video");
  const outputPath = path.join(tmpDir, "output.mp4");

  try {
    await fs.writeFile(inputPath, buffer);

    const ffmpegPath = "/opt/bin/ffmpeg";

    // Transcode command
    const args = [
      "-y",
      "-i", inputPath,
      "-c:v", "libx264",             // H.264 codec
      "-preset", "fast",             // fast encoding
      "-b:v", bitrate,               // target bitrate
      "-vf", `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease`,
      "-movflags", "+faststart",     // optimize for streaming
      "-c:a", "aac",                 // audio codec
      "-b:a", "128k",                // audio bitrate
      outputPath,
    ];

    await execFileAsync(ffmpegPath, args);

    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Generate thumbnail from URL (image or video)
 */
export async function createThumbnailFromURL(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);

  const contentType = res.headers.get("content-type")?.toLowerCase();
  if (!contentType) throw new Error("Missing content-type");

  const buffer = Buffer.from(await res.arrayBuffer());

  if (allowedImageTypes.includes(contentType)) {
    return sharp(buffer)
      .resize({ width: 1024, height: 768, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .withMetadata()
      .toBuffer();
  }

  if (allowedVideoTypes.includes(contentType)) {
    return await createVideoThumbnailFromBuffer(buffer);
  }

  throw new Error(`Unsupported file type: ${contentType}`);
}

/**
 * Generate thumbnail from File (image or video)
 */
export async function createThumbnailFromFile(file: File): Promise<Buffer> {
  const type = file.type.toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  if (allowedImageTypes.includes(type)) {
    return sharp(buffer)
      .resize({ width: 1024, height: 768, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .withMetadata()
      .toBuffer();
  }

  if (allowedVideoTypes.includes(type)) {
    return await createVideoThumbnailFromBuffer(buffer);
  }

  throw new Error(`Unsupported file type: ${type}`);
}
