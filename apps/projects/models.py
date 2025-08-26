from django.db import models
from django.contrib.auth import get_user_model
import uuid

User = get_user_model()

class Project(models.Model):
    STATUS_CHOICES = [
        ('initiated', 'Initiated'),
        ('processing', 'Processing'),
        ('created', 'Created'),
        ('failed', 'Failed'),
    ]
    
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project_id = models.CharField(max_length=255, unique=True)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='projects')
    name = models.CharField(max_length=100)
    description = models.TextField(max_length=500, blank=True, null=True)
    share_url = models.URLField()
    is_public = models.BooleanField(default=False)
    can_download = models.BooleanField(default=False)
    approved_emails = models.JSONField(default=list, blank=True)
    dropbox_folder_path = models.CharField(max_length=500, blank=True, null=True)
    dropbox_shared_link = models.URLField(blank=True, null=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='initiated')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'projects'
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name} - {self.user.username}"