import boto3
import hashlib
import hmac
import base64
import uuid
from django.conf import settings
from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from botocore.exceptions import ClientError
from .serializers import (
    SignUpSerializer, SignInSerializer, RefreshTokenSerializer,
    ForgotPasswordSerializer, ConfirmPasswordSerializer, 
    SetNewPasswordSerializer, PresignURLSerializer
)
from apps.core.utils.s3_utils import get_signed_image_url, copy_s3_object, save_s3_image
from .tasks import create_user_task

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

@api_view(['POST'])
@permission_classes([AllowAny])
def signup(request):
    serializer = SignUpSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    data = serializer.validated_data
    
    # Queue the user creation task
    task = create_user_task.delay(data)
    
    return Response({
        'message': 'User creation initiated',
        'task_id': task.id
    }, status=status.HTTP_202_ACCEPTED)

@api_view(['POST'])
@permission_classes([AllowAny])
def login(request):
    serializer = SignInSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    username = serializer.validated_data['username']
    password = serializer.validated_data['password']
    
    try:
        secret_hash = calculate_secret_hash(
            username, 
            settings.AWS_COGNITO_CLIENT_ID, 
            settings.AWS_COGNITO_CLIENT_SECRET
        )
        
        response = cognito_client.initiate_auth(
            ClientId=settings.AWS_COGNITO_CLIENT_ID,
            AuthFlow='USER_PASSWORD_AUTH',
            AuthParameters={
                'USERNAME': username,
                'PASSWORD': password,
                'SECRET_HASH': secret_hash
            }
        )
        
        if 'AuthenticationResult' not in response:
            return Response(
                {'error': 'Authentication failed'}, 
                status=status.HTTP_401_UNAUTHORIZED
            )
        
        auth_result = response['AuthenticationResult']
        access_token = auth_result['AccessToken']
        
        # Get user info from Cognito
        user_response = cognito_client.get_user(AccessToken=access_token)
        
        user_attributes = {attr['Name']: attr['Value'] for attr in user_response['UserAttributes']}
        user_sub = user_attributes['sub']
        
        # Get user details from database
        try:
            user = User.objects.get(user_id=user_sub)
            from apps.users.serializers import UserSerializer
            user_data = UserSerializer(user).data
        except User.DoesNotExist:
            user_data = None
        
        return Response({
            'token': {
                'accessToken': auth_result['AccessToken'],
                'refreshToken': auth_result.get('RefreshToken'),
                'idToken': auth_result.get('IdToken'),
                'expiresIn': auth_result.get('ExpiresIn')
            },
            'user': user_data
        })
        
    except ClientError as e:
        return Response(
            {'error': str(e)}, 
            status=status.HTTP_401_UNAUTHORIZED
        )

@api_view(['POST'])
@permission_classes([AllowAny])
def refresh_token(request):
    serializer = RefreshTokenSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    refresh_token = serializer.validated_data['refresh_token']
    
    # Extract username from the authorization header
    auth_header = request.META.get('HTTP_AUTHORIZATION', '')
    if not auth_header:
        return Response(
            {'error': 'Missing Authorization header'}, 
            status=status.HTTP_401_UNAUTHORIZED
        )
    
    try:
        import jwt
        token = auth_header.split(' ')[1]
        decoded = jwt.decode(token, options={"verify_signature": False})
        username = decoded.get('username') or decoded.get('cognito:username')
        
        secret_hash = calculate_secret_hash(
            username, 
            settings.AWS_COGNITO_CLIENT_ID, 
            settings.AWS_COGNITO_CLIENT_SECRET
        )
        
        response = cognito_client.initiate_auth(
            ClientId=settings.AWS_COGNITO_CLIENT_ID,
            AuthFlow='REFRESH_TOKEN_AUTH',
            AuthParameters={
                'REFRESH_TOKEN': refresh_token,
                'SECRET_HASH': secret_hash
            }
        )
        
        auth_result = response['AuthenticationResult']
        
        return Response({
            'accessToken': auth_result['AccessToken'],
            'refreshToken': auth_result.get('RefreshToken'),
            'idToken': auth_result.get('IdToken'),
            'expiresIn': auth_result.get('ExpiresIn')
        })
        
    except Exception as e:
        return Response(
            {'error': str(e)}, 
            status=status.HTTP_401_UNAUTHORIZED
        )

@api_view(['POST'])
@permission_classes([AllowAny])
def forgot_password(request):
    serializer = ForgotPasswordSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    email = serializer.validated_data['email']
    
    try:
        cognito_client.forgot_password(
            ClientId=settings.AWS_COGNITO_CLIENT_ID,
            Username=email
        )
        
        return Response({'message': 'Password reset code sent'})
        
    except ClientError as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

@api_view(['POST'])
@permission_classes([AllowAny])
def confirm_password(request):
    serializer = ConfirmPasswordSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    data = serializer.validated_data
    
    try:
        cognito_client.confirm_forgot_password(
            ClientId=settings.AWS_COGNITO_CLIENT_ID,
            Username=data['email'],
            ConfirmationCode=data['code'],
            Password=data['new_password']
        )
        
        return Response({'message': 'Password reset successful'})
        
    except ClientError as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

@api_view(['POST'])
@permission_classes([AllowAny])
def set_new_password(request):
    serializer = SetNewPasswordSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    data = serializer.validated_data
    
    try:
        cognito_client.admin_set_user_password(
            UserPoolId=settings.AWS_COGNITO_USER_POOL_ID,
            Username=data['email'],
            Password=data['new_password'],
            Permanent=True
        )
        
        return Response({'message': 'Password updated successfully'})
        
    except ClientError as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def get_presign_url(request):
    serializer = PresignURLSerializer(data=request.GET)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    data = serializer.validated_data
    bucket = data.get('bucket') or settings.AWS_S3_TEMP_BUCKET
    key = data['key']
    content_type = data['content_type']
    
    try:
        presigned_url = s3_client.generate_presigned_url(
            'put_object',
            Params={
                'Bucket': bucket,
                'Key': key,
                'ContentType': content_type
            },
            ExpiresIn=300  # 5 minutes
        )
        
        return Response({
            'upload_url': presigned_url,
            'key': key
        })
        
    except ClientError as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def get_presign_post(request):
    serializer = PresignURLSerializer(data=request.GET)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    data = serializer.validated_data
    key = data['key']
    content_type = data['content_type']
    user_id = request.user.user_id
    
    # Enforce user folder structure
    if not key.startswith(f'{user_id}/'):
        return Response(
            {'error': 'Key must start with user ID'}, 
            status=status.HTTP_400_BAD_REQUEST
        )
    
    try:
        presigned_post = s3_client.generate_presigned_post(
            Bucket=settings.AWS_S3_TEMP_BUCKET,
            Key=key,
            Fields={'Content-Type': content_type},
            Conditions=[
                ['content-length-range', 0, 50 * 1024 * 1024],  # 50MB max
                ['eq', '$Content-Type', content_type],
                ['starts-with', '$key', f'{user_id}/']
            ],
            ExpiresIn=300
        )
        
        return Response({
            'upload_url': presigned_post['url'],
            'fields': presigned_post['fields'],
            'key': key,
            'max_size': 50 * 1024 * 1024
        })
        
    except ClientError as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)