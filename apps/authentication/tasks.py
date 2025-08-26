import boto3
import hashlib
import hmac
import base64
from celery import shared_task
from django.conf import settings
from django.contrib.auth import get_user_model
from botocore.exceptions import ClientError
from apps.core.utils.s3_utils import copy_s3_object, save_s3_image

User = get_user_model()

# Initialize AWS clients
cognito_client = boto3.client(
    'cognito-idp',
    region_name=settings.AWS_COGNITO_REGION,
    aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
    aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY
)

s3_client = boto3.client(
    's3',
    region_name=settings.AWS_S3_REGION_NAME,
    aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
    aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY
)

def calculate_secret_hash(username, client_id, client_secret):
    message = username + client_id
    dig = hmac.new(
        client_secret.encode('UTF-8'),
        message.encode('UTF-8'),
        hashlib.sha256
    ).digest()
    return base64.b64encode(dig).decode()

@shared_task(bind=True, max_retries=3)
def create_user_task(self, user_data):
    """
    Celery task to handle user creation with Cognito and database operations
    """
    username = user_data['username']
    created_user_sub = None
    uploaded_avatar_key = None
    user_instance = None
    
    try:
        # Create user in Cognito
        secret_hash = calculate_secret_hash(
            username,
            settings.AWS_COGNITO_CLIENT_ID,
            settings.AWS_COGNITO_CLIENT_SECRET
        )
        
        response = cognito_client.sign_up(
            ClientId=settings.AWS_COGNITO_CLIENT_ID,
            SecretHash=secret_hash,
            Username=username,
            Password=user_data['password'],
            UserAttributes=[
                {'Name': 'email', 'Value': user_data['email']},
                {'Name': 'given_name', 'Value': user_data['first_name']},
                {'Name': 'family_name', 'Value': user_data['last_name']},
            ]
        )
        
        created_user_sub = response['UserSub']
        
        # Auto-confirm user in development
        if settings.DEBUG:
            cognito_client.admin_confirm_sign_up(
                UserPoolId=settings.AWS_COGNITO_USER_POOL_ID,
                Username=username
            )
        
        # Handle avatar upload
        avatar_bucket = None
        avatar_key = None
        
        if user_data.get('avatar'):
            avatar_data = user_data['avatar']
            ext = avatar_data['key'].split('.')[-1]
            new_key = f"profile_images/{created_user_sub}.{ext}"
            
            # Copy from temp bucket to app bucket
            copy_s3_object(
                s3_client,
                source_bucket=avatar_data['bucket'],
                source_key=avatar_data['key'],
                dest_bucket=settings.AWS_STORAGE_BUCKET_NAME,
                dest_key=new_key
            )
            
            # Delete from temp bucket
            s3_client.delete_object(
                Bucket=settings.AWS_S3_TEMP_BUCKET,
                Key=avatar_data['key']
            )
            
            avatar_bucket = settings.AWS_STORAGE_BUCKET_NAME
            avatar_key = new_key
            uploaded_avatar_key = new_key
        
        # Create user in database
        dropbox_data = user_data.get('dropbox', {})
        
        user_instance = User.objects.create(
            user_id=created_user_sub,
            username=username,
            email=user_data['email'],
            first_name=user_data['first_name'],
            last_name=user_data['last_name'],
            bio=user_data.get('bio', ''),
            avatar_bucket=avatar_bucket,
            avatar_key=avatar_key,
            dropbox_access_token=dropbox_data.get('access_token'),
            dropbox_refresh_token=dropbox_data.get('refresh_token')
        )
        
        return {
            'success': True,
            'user_id': created_user_sub,
            'message': 'User created successfully'
        }
        
    except Exception as e:
        # Cleanup on failure
        cleanup_failed_signup.delay({
            'user_sub': created_user_sub,
            'username': username,
            'uploaded_avatar_key': uploaded_avatar_key,
            'user_instance_id': user_instance.id if user_instance else None
        })
        
        # Retry the task
        if self.request.retries < self.max_retries:
            raise self.retry(countdown=60, exc=e)
        
        return {
            'success': False,
            'error': str(e),
            'message': 'User creation failed after retries'
        }

@shared_task
def cleanup_failed_signup(cleanup_data):
    """
    Cleanup task for failed user creation
    """
    try:
        # Delete from database
        if cleanup_data.get('user_instance_id'):
            try:
                user = User.objects.get(id=cleanup_data['user_instance_id'])
                user.delete()
            except User.DoesNotExist:
                pass
        
        # Delete from Cognito
        if cleanup_data.get('user_sub'):
            try:
                cognito_client.admin_delete_user(
                    UserPoolId=settings.AWS_COGNITO_USER_POOL_ID,
                    Username=cleanup_data['username']
                )
            except ClientError:
                pass
        
        # Delete avatar from S3
        if cleanup_data.get('uploaded_avatar_key'):
            try:
                s3_client.delete_object(
                    Bucket=settings.AWS_STORAGE_BUCKET_NAME,
                    Key=cleanup_data['uploaded_avatar_key']
                )
            except ClientError:
                pass
                
    except Exception as e:
        # Log the cleanup failure but don't raise
        print(f"Cleanup failed: {str(e)}")