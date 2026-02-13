import fetch from "node-fetch";
import sharp from "sharp";
import * as fs from "fs";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";

/**
 * Returns the correct ffmpeg path depending on environment.
 * Tries @ffmpeg-installer/ffmpeg first (local/dev),
 * then falls back to Lambda layer path (/opt/bin/ffmpeg).
 */
export async function getFfmpegPath(): Promise<string> {
  try {
    const ffmpegInstaller = await import('@ffmpeg-installer/ffmpeg');
    
    if (fs.existsSync(ffmpegInstaller.path)) {
      console.log('Using local ffmpeg installer:', ffmpegInstaller.path);
      return ffmpegInstaller.path;
    } else {
      throw new Error('Local ffmpeg not found');
    }
  } catch (err) {
    // Fallback for serverless / Lambda
    const lambdaPath = '/opt/bin/ffmpeg';
    console.log('Falling back to Lambda layer ffmpeg:', lambdaPath);
    return lambdaPath;
  }
}

/**
 * Sets ffmpeg path for fluent-ffmpeg
 */
export async function configureFfmpeg() {
  const ffmpegPath = await getFfmpegPath();
  ffmpeg.setFfmpegPath(ffmpegPath);
}; // use static binary

export const allowedImageTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/tiff",
  "image/heic",
  "image/heif",
];

export const allowedVideoTypes = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
];

/**
 * Create video thumbnail in Lambda using ffmpeg layer
 */
export async function createVideoThumbnailFromBuffer(buffer: Buffer): Promise<Buffer> {
  await configureFfmpeg()
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thumb-"));
  const inputPath = path.join(tmpDir, "input.video");
  const outputPath = path.join(tmpDir, "thumb.jpg");

  try {
    // Save the video buffer to a temporary file
    await fs.promises.writeFile(inputPath, buffer);

    // Generate thumbnail using fluent-ffmpeg
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .screenshots({
          timestamps: [0.1], // skip the first black frame (in seconds)
          filename: path.basename(outputPath),
          folder: tmpDir,
        })
        .on('end', () => resolve())
        .on('error', (err) => reject(err));
    });

    // Read the extracted frame and resize with sharp
    const thumbnailBuffer = await sharp(outputPath)
      .resize({ width: 1024, height: 768, fit: "inside", withoutEnlargement: true })
      .jpeg() // ensure output is JPEG
      .toBuffer();

    return thumbnailBuffer;;
  } finally {
    // Clean up temporary files
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
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
  await configureFfmpeg()
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-"));
  const inputPath = path.join(tmpDir, "input.video");
  const outputPath = path.join(tmpDir, "output.mp4");

  try {
    // Write input video to disk
    await fs.promises.writeFile(inputPath, buffer);

    // Run fluent-ffmpeg
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          "-c:v libx264",                        // H.264 codec
          "-preset fast",                        // encoding preset
          `-b:v ${bitrate}`,                     // target bitrate
          `-vf scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease`, // scaling
          "-movflags +faststart",                // streaming optimization
          "-c:a aac",                            // audio codec
          "-b:a 128k",                           // audio bitrate
        ])
        .save(outputPath)
        .on("end", () => resolve())
        .on("error", (err: any) => reject(err));
    });

    // Read output file into buffer
    return await fs.promises.readFile(outputPath);
  } finally {
    // Clean up temp folder
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
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
