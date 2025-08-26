from django.contrib.auth.models import AbstractUser
from django.db import models
import uuid

class User(AbstractUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_id = models.CharField(max_length=255, unique=True)  # Cognito sub
    email = models.EmailField(unique=True)
    first_name = models.CharField(max_length=50)
    last_name = models.CharField(max_length=50)
    bio = models.TextField(max_length=500, blank=True, null=True)
    avatar_bucket = models.CharField(max_length=255, blank=True, null=True)
    avatar_key = models.CharField(max_length=255, blank=True, null=True)
    dropbox_access_token = models.TextField(blank=True, null=True)
    dropbox_refresh_token = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    USERNAME_FIELD = 'username'
    REQUIRED_FIELDS = ['email', 'first_name', 'last_name']

    class Meta:
        db_table = 'users'

    def __str__(self):
        return self.username

    @property
    def avatar_s3_location(self):
        if self.avatar_bucket and self.avatar_key:
            return {
                'bucket': self.avatar_bucket,
                'key': self.avatar_key
            }
        return None

    @property
    def dropbox_tokens(self):
        if self.dropbox_access_token:
            return {
                'access_token': self.dropbox_access_token,
                'refresh_token': self.dropbox_refresh_token
            }
        return None