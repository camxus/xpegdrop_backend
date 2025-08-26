from rest_framework import serializers
from .models import Project

class ProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Project
        fields = [
            'project_id', 'name', 'description', 'share_url', 'is_public',
            'can_download', 'approved_emails', 'dropbox_folder_path',
            'dropbox_shared_link', 'status', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'project_id', 'share_url', 'dropbox_folder_path', 
            'dropbox_shared_link', 'status', 'created_at', 'updated_at'
        ]

class CreateProjectSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=100)
    description = serializers.CharField(max_length=500, required=False, allow_blank=True)
    file_locations = serializers.JSONField(required=False, allow_null=True)

class UpdateProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Project
        fields = ['name', 'description', 'is_public', 'can_download', 'approved_emails']

class PublicProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Project
        fields = ['name', 'description', 'dropbox_shared_link', 'created_at']