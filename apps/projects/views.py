import uuid
from django.shortcuts import get_object_or_404
from django.conf import settings
from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes, parser_classes
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser, FormParser
from .models import Project
from .serializers import (
    ProjectSerializer, CreateProjectSerializer, 
    UpdateProjectSerializer, PublicProjectSerializer
)
from .tasks import create_project_task
from apps.users.serializers import PublicUserSerializer
from apps.dropbox_integration.services import DropboxService

class ProjectListView(generics.ListAPIView):
    serializer_class = ProjectSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Project.objects.filter(user=self.request.user)

class ProjectDetailView(generics.RetrieveAPIView):
    serializer_class = ProjectSerializer
    permission_classes = [IsAuthenticated]
    lookup_field = 'project_id'

    def get_queryset(self):
        return Project.objects.filter(user=self.request.user)

class ProjectUpdateView(generics.UpdateAPIView):
    serializer_class = UpdateProjectSerializer
    permission_classes = [IsAuthenticated]
    lookup_field = 'project_id'

    def get_queryset(self):
        return Project.objects.filter(user=self.request.user)

class ProjectDeleteView(generics.DestroyAPIView):
    permission_classes = [IsAuthenticated]
    lookup_field = 'project_id'

    def get_queryset(self):
        return Project.objects.filter(user=self.request.user)

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        self.perform_destroy(instance)
        return Response({'message': 'Project deleted successfully'}, status=status.HTTP_200_OK)

@api_view(['POST'])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser])
def create_project(request):
    serializer = CreateProjectSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    data = serializer.validated_data
    files = request.FILES.getlist('files')
    file_locations = data.get('file_locations', [])
    
    if not files and not file_locations:
        return Response(
            {'error': 'No files provided'}, 
            status=status.HTTP_400_BAD_REQUEST
        )
    
    if not request.user.dropbox_access_token:
        return Response(
            {'error': 'Dropbox access token not found. Please connect your Dropbox account.'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # Create project record
    project_id = str(uuid.uuid4())
    share_url = f"{settings.FRONTEND_URL}/{request.user.username}/{data['name'].lower().replace(' ', '-')}"
    
    project = Project.objects.create(
        project_id=project_id,
        user=request.user,
        name=data['name'],
        description=data.get('description', ''),
        share_url=share_url,
        status='initiated'
    )
    
    # Prepare task data
    task_data = {
        'project_id': project_id,
        'user_data': {
            'user_id': request.user.user_id,
            'username': request.user.username,
            'dropbox_access_token': request.user.dropbox_access_token,
            'dropbox_refresh_token': request.user.dropbox_refresh_token,
        },
        'project_data': {
            'name': data['name'],
            'description': data.get('description', ''),
        },
        'files': [],
        'file_locations': file_locations or []
    }
    
    # Process uploaded files
    if files:
        for file in files:
            task_data['files'].append({
                'name': file.name,
                'content_type': file.content_type,
                'content': file.read()  # Read file content
            })
    
    # Queue the project creation task
    create_project_task.delay(task_data)
    
    serializer = ProjectSerializer(project)
    return Response(serializer.data, status=status.HTTP_202_ACCEPTED)

@api_view(['GET'])
@permission_classes([AllowAny])
def get_project_by_share_url(request, username, project_name):
    # Find project by share URL pattern
    projects = Project.objects.filter(
        share_url__icontains=f"/{username}/{project_name}"
    )
    
    if not projects.exists():
        return Response(
            {'error': 'Project not found'}, 
            status=status.HTTP_404_NOT_FOUND
        )
    
    project = projects.first()
    is_public = project.is_public
    approved_emails = [email.lower() for email in project.approved_emails]
    email_param = request.GET.get('email', '').lower()
    
    # Check access permissions
    if not is_public and (not hasattr(request, 'user') or request.user.username != username):
        if not email_param:
            return Response(
                {'error': 'EMAIL_REQUIRED'}, 
                status=status.HTTP_400_BAD_REQUEST
            )
        
        if email_param not in approved_emails:
            return Response(
                {'error': 'EMAIL_INVALID'}, 
                status=status.HTTP_403_FORBIDDEN
            )
    
    # Get project owner info
    user_serializer = PublicUserSerializer(project.user)
    
    # Get Dropbox files
    try:
        dropbox_service = DropboxService(project.user.dropbox_access_token)
        dropbox_files = dropbox_service.list_files(project.dropbox_folder_path or '')
        
        # Filter for images
        images = [
            file for file in dropbox_files 
            if file['name'].lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp'))
        ]
        
    except Exception as e:
        # Try to refresh token if available
        if project.user.dropbox_refresh_token:
            try:
                dropbox_service = DropboxService(project.user.dropbox_access_token)
                new_token = dropbox_service.refresh_token(
                    project.user.dropbox_refresh_token,
                    project.user
                )
                
                # Retry with new token
                dropbox_service = DropboxService(new_token)
                dropbox_files = dropbox_service.list_files(project.dropbox_folder_path or '')
                images = [
                    file for file in dropbox_files 
                    if file['name'].lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp'))
                ]
                
            except Exception:
                return Response(
                    {'error': 'Dropbox session expired. Please reconnect.'},
                    status=status.HTTP_401_UNAUTHORIZED
                )
        else:
            return Response(
                {'error': 'Failed to access Dropbox files'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
    
    project_serializer = PublicProjectSerializer(project)
    
    return Response({
        'project': project_serializer.data,
        'user': user_serializer.data,
        'images': images
    })