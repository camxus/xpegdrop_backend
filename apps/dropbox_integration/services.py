import dropbox
import requests
from django.conf import settings
from django.contrib.auth import get_user_model
from io import BytesIO
import time

User = get_user_model()

class DropboxService:
    def __init__(self, access_token):
        self.dbx = dropbox.Dropbox(access_token)
    
    def folder_exists(self, folder_path):
        """Check if a folder exists in Dropbox"""
        try:
            self.dbx.files_get_metadata(folder_path)
            return True
        except dropbox.exceptions.ApiError as e:
            if e.error.is_path() and e.error.get_path().is_not_found():
                return False
            raise e
    
    def upload_files(self, files, folder_name, batch_size=3):
        """Upload files to Dropbox in batches"""
        folder_path = f'/xpegdrop/{folder_name}'
        
        # Create folder if it doesn't exist
        if not self.folder_exists(folder_path):
            self.dbx.files_create_folder_v2(folder_path, autorename=True)
        
        # Upload files in batches
        for i in range(0, len(files), batch_size):
            batch = files[i:i + batch_size]
            
            for file_obj in batch:
                self._upload_single_file(file_obj, folder_path)
            
            # Small delay between batches
            time.sleep(0.5)
        
        # Create shared link
        shared_link_response = self.dbx.sharing_create_shared_link_with_settings(
            folder_path,
            settings=dropbox.sharing.SharedLinkSettings(
                requested_visibility=dropbox.sharing.RequestedVisibility.public
            )
        )
        
        return {
            'folder_path': folder_path,
            'share_link': shared_link_response.url
        }
    
    def _upload_single_file(self, file_obj, folder_path):
        """Upload a single file with retry logic for rate limiting"""
        file_path = f"{folder_path}/{file_obj.name}"
        
        # Read file content
        if hasattr(file_obj, 'read'):
            content = file_obj.read()
        else:
            content = file_obj
        
        uploaded = False
        while not uploaded:
            try:
                self.dbx.files_upload(
                    content,
                    file_path,
                    mode=dropbox.files.WriteMode.add,
                    autorename=False
                )
                uploaded = True
            except dropbox.exceptions.RateLimitError as e:
                # Wait for the specified retry time
                retry_after = getattr(e, 'retry_after', 1)
                time.sleep(retry_after + 1)
    
    def list_files(self, folder_path):
        """List files in a Dropbox folder with preview URLs"""
        try:
            response = self.dbx.files_list_folder(folder_path)
            
            # Filter for image files
            image_files = [
                entry for entry in response.entries
                if isinstance(entry, dropbox.files.FileMetadata) and
                entry.name.lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp'))
            ]
            
            files_with_links = []
            for file_entry in image_files:
                # Get temporary link for preview
                link_response = self.dbx.files_get_temporary_link(file_entry.path_lower)
                
                # Get thumbnail
                try:
                    thumbnail_response = self.dbx.files_get_thumbnail_v2(
                        resource=dropbox.files.PathOrLink.path(file_entry.path_lower),
                        format=dropbox.files.ThumbnailFormat.jpeg,
                        size=dropbox.files.ThumbnailSize.w2048h1536
                    )
                    
                    # Convert thumbnail to base64
                    import base64
                    thumbnail_base64 = base64.b64encode(thumbnail_response.content).decode('utf-8')
                    thumbnail_url = f"data:image/jpeg;base64,{thumbnail_base64}"
                    
                except Exception:
                    thumbnail_url = link_response.link  # Fallback to full image
                
                files_with_links.append({
                    'name': file_entry.name,
                    'preview_url': link_response.link,
                    'thumbnail_url': thumbnail_url
                })
            
            return files_with_links
            
        except Exception as e:
            raise e
    
    def create_shared_link(self, path):
        """Create a shared link for a file or folder"""
        try:
            response = self.dbx.sharing_create_shared_link_with_settings(
                path,
                settings=dropbox.sharing.SharedLinkSettings(
                    requested_visibility=dropbox.sharing.RequestedVisibility.public
                )
            )
            return response.url
        except Exception as e:
            raise e
    
    def refresh_token(self, refresh_token, user):
        """Refresh the Dropbox access token"""
        try:
            response = requests.post(
                'https://api.dropbox.com/oauth2/token',
                data={
                    'grant_type': 'refresh_token',
                    'refresh_token': refresh_token,
                    'client_id': settings.DROPBOX_CLIENT_ID,
                    'client_secret': settings.DROPBOX_CLIENT_SECRET,
                },
                headers={'Content-Type': 'application/x-www-form-urlencoded'}
            )
            
            if response.status_code == 200:
                token_data = response.json()
                new_access_token = token_data['access_token']
                
                # Update user's token in database
                user.dropbox_access_token = new_access_token
                user.save()
                
                # Update current instance
                self.dbx = dropbox.Dropbox(new_access_token)
                
                return new_access_token
            else:
                raise Exception(f"Token refresh failed: {response.text}")
                
        except Exception as e:
            raise e