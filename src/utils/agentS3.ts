import { S3Client, PutObjectCommand, CopyObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Location } from '../types';

export const s3Client = new S3Client({ region: process.env.AWS_REGION_CODE });

export const TEMP_BUCKET = process.env.EXPRESS_S3_TEMP_BUCKET!;
export const APP_BUCKET = process.env.EXPRESS_S3_APP_BUCKET!;

export async function uploadBufferToS3(
  bucket: string,
  key: string,
  buffer: Buffer,
  contentType: string
): Promise<S3Location> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return { bucket, key };
}

export async function copyS3Object(
  source: S3Location,
  destinationBucket: string,
  destinationKey: string
): Promise<S3Location> {
  await s3Client.send(
    new CopyObjectCommand({
      CopySource: encodeURIComponent(`${source.bucket}/${source.key}`),
      Bucket: destinationBucket,
      Key: destinationKey,
    })
  );

  return { bucket: destinationBucket, key: destinationKey };
}

export function buildAgentImageKey(userId: string, sessionId: string, fileName: string) {
  const ext = fileName.split('.').pop() || 'bin';
  return `agents/${userId}/${sessionId}/input.${ext}`;
}

export function getSignedS3Url(location: S3Location, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: location.bucket,
    Key: location.key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}
