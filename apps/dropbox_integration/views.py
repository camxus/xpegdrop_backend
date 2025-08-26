import uuid
import jwt
from django.conf import settings
from django.shortcuts import redirect
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
import requests
from urllib.parse import urlencode

@api_view(['GET'])
@permission_classes([AllowAny])
def get_dropbox_auth_url(request):
    """Generate Dropbox OAuth authorization URL"""
    state = str(uuid.uuid4())  # CSRF protection
    
    params = {
        'client_id': settings.DROPBOX_CLIENT_ID,
        'response_type': 'code',
        'redirect_uri': f"{settings.BACKEND_URL}/api/dropbox/callback/",
        'state': state,
        'token_access_type': 'offline'  # Get refresh token
    }
    
    auth_url = f"https://www.dropbox.com/oauth2/authorize?{urlencode(params)}"
    
    return Response({'url': auth_url})

@api_view(['GET'])
@permission_classes([AllowAny])
def handle_dropbox_callback(request):
    """Handle Dropbox OAuth callback"""
    code = request.GET.get('code')
    
    if not code:
        return redirect(f"{settings.FRONTEND_URL}/signup?error=dropbox_auth_failed")
    
    try:
        # Exchange code for tokens
        token_response = requests.post(
            'https://api.dropbox.com/oauth2/token',
            data={
                'code': code,
                'grant_type': 'authorization_code',
                'client_id': settings.DROPBOX_CLIENT_ID,
                'client_secret': settings.DROPBOX_CLIENT_SECRET,
                'redirect_uri': f"{settings.BACKEND_URL}/api/dropbox/callback/",
            },
            headers={'Content-Type': 'application/x-www-form-urlencoded'}
        )
        
        if token_response.status_code != 200:
            return redirect(f"{settings.FRONTEND_URL}/signup?error=dropbox_token_failed")
        
        token_data = token_response.json()
        
        # Create a temporary JWT with the tokens
        state_token = jwt.encode(
            {
                'access_token': token_data['access_token'],
                'refresh_token': token_data.get('refresh_token'),
                'account_id': token_data.get('account_id'),
                'uid': token_data.get('uid'),
            },
            settings.SECRET_KEY,
            algorithm='HS256'
        )
        
        # Redirect to frontend with token
        return redirect(f"{settings.FRONTEND_URL}/signup?dropbox_token={state_token}")
        
    except Exception as e:
        return redirect(f"{settings.FRONTEND_URL}/signup?error=dropbox_callback_failed")