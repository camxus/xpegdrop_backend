import boto3
from django.conf import settings
from botocore.exceptions import ClientError
from PIL import Image
from io import BytesIO

# Initialize S3 client
s3_client = boto3.client(
    's3',
    region_name=settings.AWS_S3_REGION_NAME,
    aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
    aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY
)

def get_signed_image_url(s3_location, expiration=3600):
    """Generate a signed URL for an S3 object"""
    if not s3_location or not s3_location.get('bucket') or not s3_location.get('key'):
        return None
    
    try:
        url = s3_client.generate_presigned_url(
            'get_object',
            Params={
                'Bucket': s3_location['bucket'],
                'Key': s3_location['key']
            },
            ExpiresIn=expiration
        )
        return url
    except ClientError as e:
        print(f"Error generating signed URL: {e}")
        return None

def copy_s3_object(source_bucket, source_key, dest_bucket, dest_key):
    """Copy an object from one S3 location to another"""
    try:
        copy_source = {'Bucket': source_bucket, 'Key': source_key}
        s3_client.copy_object(
            CopySource=copy_source,
            Bucket=dest_bucket,
            Key=dest_key,
            ACL='public-read'
        )
        return {'bucket': dest_bucket, 'key': dest_key}
    except ClientError as e:
        print(f"Error copying S3 object: {e}")
        raise e

def save_s3_image(bucket, key, image_content):
    """Save image content to S3"""
    try:
        s3_client.put_object(
            Bucket=bucket,
            Key=key,
            Body=image_content,
            ContentType='image/jpeg',
            ACL='public-read'
        )
        return {'bucket': bucket, 'key': key}
    except ClientError as e:
        print(f"Error saving image to S3: {e}")
        raise e

def delete_s3_object(bucket, key):
    """Delete an object from S3"""
    try:
        s3_client.delete_object(Bucket=bucket, Key=key)
        return True
    except ClientError as e:
        print(f"Error deleting S3 object: {e}")
        return False

def get_s3_file(bucket, key):
    """Get file content from S3"""
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
        return response['Body'].read()
    except ClientError as e:
        print(f"Error getting S3 file: {e}")
        raise e

def process_image_upload(image_file, bucket, key_prefix):
    """Process and upload an image file to S3"""
    try:
        # Open and process image
        image = Image.open(image_file)
        
        # Convert to RGB if necessary
        if image.mode in ('RGBA', 'LA', 'P'):
            image = image.convert('RGB')
        
        # Save to BytesIO
        output = BytesIO()
        image.save(output, format='JPEG', quality=85, optimize=True)
        output.seek(0)
        
        # Generate key
        import uuid
        file_extension = 'jpg'
        key = f"{key_prefix}/{uuid.uuid4()}.{file_extension}"
        
        # Upload to S3
        result = save_s3_image(bucket, key, output.getvalue())
        
        return result
        
    except Exception as e:
        print(f"Error processing image upload: {e}")
        raise e