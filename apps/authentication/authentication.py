import jwt
import requests
from django.conf import settings
from django.contrib.auth import get_user_model
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed
from cryptography.hazmat.primitives import serialization
import json

User = get_user_model()

class CognitoAuthentication(BaseAuthentication):
    def authenticate(self, request):
        auth_header = request.META.get('HTTP_AUTHORIZATION')
        
        if not auth_header or not auth_header.startswith('Bearer '):
            return None
            
        token = auth_header[7:]  # Remove 'Bearer ' prefix
        
        try:
            # Verify and decode the JWT token
            decoded_token = self.verify_cognito_token(token)
            
            # Get or create user
            user = self.get_or_create_user(decoded_token)
            
            return (user, token)
            
        except Exception as e:
            raise AuthenticationFailed(f'Invalid token: {str(e)}')
    
    def verify_cognito_token(self, token):
        # Get Cognito public keys
        region = settings.AWS_COGNITO_REGION
        user_pool_id = settings.AWS_COGNITO_USER_POOL_ID
        
        jwks_url = f'https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json'
        
        try:
            jwks_response = requests.get(jwks_url)
            jwks = jwks_response.json()
        except Exception:
            raise AuthenticationFailed('Unable to fetch JWKS')
        
        # Decode token header to get key ID
        try:
            header = jwt.get_unverified_header(token)
            kid = header['kid']
        except Exception:
            raise AuthenticationFailed('Invalid token header')
        
        # Find the correct key
        key = None
        for jwk in jwks['keys']:
            if jwk['kid'] == kid:
                key = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(jwk))
                break
        
        if not key:
            raise AuthenticationFailed('Unable to find appropriate key')
        
        # Verify and decode token
        try:
            decoded_token = jwt.decode(
                token,
                key,
                algorithms=['RS256'],
                audience=settings.AWS_COGNITO_CLIENT_ID,
                issuer=f'https://cognito-idp.{region}.amazonaws.com/{user_pool_id}'
            )
            return decoded_token
        except jwt.ExpiredSignatureError:
            raise AuthenticationFailed('Token has expired')
        except jwt.InvalidTokenError:
            raise AuthenticationFailed('Invalid token')
    
    def get_or_create_user(self, decoded_token):
        user_id = decoded_token['sub']
        username = decoded_token.get('cognito:username', decoded_token.get('username'))
        email = decoded_token.get('email', '')
        
        try:
            user = User.objects.get(user_id=user_id)
        except User.DoesNotExist:
            # Create user if doesn't exist
            user = User.objects.create(
                user_id=user_id,
                username=username,
                email=email,
                first_name=decoded_token.get('given_name', ''),
                last_name=decoded_token.get('family_name', ''),
            )
        
        return user