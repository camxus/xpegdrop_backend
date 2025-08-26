import uuid
from celery import shared_task
from django.contrib.auth import get_user_model
from .models import Project
from apps.dropbox_integration.services import DropboxService
from apps.core.utils.s3_utils import get_s3_file

User = get_user_model()

@shared_task(bind=True, max_retries=3)
def create_project_task(self, task_data):
    """
    Celery task to handle project creation with Dropbox upload
    """
    project_id = task_data['project_id']
    user_data = task_data['user_data']
    project_data = task_data['project_data']
    files_data = task_data['files']
    file_locations = task_data['file_locations']
    
    try:
        # Get project instance
        project = Project.objects.get(project_id=project_id)
        project.status = 'processing'
        project.save()
        
        # Initialize Dropbox service
        dropbox_service = DropboxService(user_data['dropbox_access_token'])
        
        # Prepare files for upload
        files_to_upload = []
        
        # Process direct file uploads
        for file_data in files_data:
            # Create file-like object from content
            from io import BytesIO
            file_obj = BytesIO(file_data['content'])
            file_obj.name = file_data['name']
            files_to_upload.append(file_obj)
        
        # Process S3 file locations
        for location in file_locations:
            file_content = get_s3_file(location['bucket'], location['key'])
            file_obj = BytesIO(file_content)
            file_obj.name = location['key'].split('/')[-1]  # Extract filename
            files_to_upload.append(file_obj)
        
        # Upload to Dropbox
        try:
            result = dropbox_service.upload_files(files_to_upload, project_data['name'])
        except Exception as e:
            # Try refreshing token if available
            if user_data.get('dropbox_refresh_token'):
                user = User.objects.get(user_id=user_data['user_id'])
                new_token = dropbox_service.refresh_token(
                    user_data['dropbox_refresh_token'], 
                    user
                )
                dropbox_service = DropboxService(new_token)
                result = dropbox_service.upload_files(files_to_upload, project_data['name'])
            else:
                raise e
        
        # Update project with Dropbox info
        project.dropbox_folder_path = result['folder_path']
        project.dropbox_shared_link = result['share_link']
        project.status = 'created'
        project.save()
        
        return {
            'success': True,
            'project_id': project_id,
            'message': 'Project created successfully'
        }
        
    except Exception as e:
        # Update project status to failed
        try:
            project = Project.objects.get(project_id=project_id)
            project.status = 'failed'
            project.save()
        except Project.DoesNotExist:
            pass
        
        # Retry the task
        if self.request.retries < self.max_retries:
            raise self.retry(countdown=60, exc=e)
        
        return {
            'success': False,
            'error': str(e),
            'message': 'Project creation failed after retries'
        }