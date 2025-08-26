from rest_framework import serializers
from .models import User
from apps.core.utils.s3_utils import get_signed_image_url

class UserSerializer(serializers.ModelSerializer):
    avatar = serializers.SerializerMethodField()
    dropbox = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'user_id', 'username', 'email', 'first_name', 'last_name', 
            'bio', 'avatar', 'dropbox', 'created_at', 'updated_at'
        ]
        read_only_fields = ['user_id', 'created_at', 'updated_at']

    def get_avatar(self, obj):
        if obj.avatar_s3_location:
            return get_signed_image_url(obj.avatar_s3_location)
        return None

    def get_dropbox(self, obj):
        # Don't expose tokens in serialization
        if obj.dropbox_tokens:
            return {'connected': True}
        return None

class UserUpdateSerializer(serializers.ModelSerializer):
    avatar = serializers.JSONField(required=False, allow_null=True)
    dropbox = serializers.JSONField(required=False, allow_null=True)

    class Meta:
        model = User
        fields = ['first_name', 'last_name', 'bio', 'avatar', 'dropbox']

    def update(self, instance, validated_data):
        avatar_data = validated_data.pop('avatar', None)
        dropbox_data = validated_data.pop('dropbox', None)

        # Update basic fields
        for attr, value in validated_data.items():
            setattr(instance, attr, value)

        # Handle avatar update
        if avatar_data:
            instance.avatar_bucket = avatar_data.get('bucket')
            instance.avatar_key = avatar_data.get('key')

        # Handle dropbox tokens
        if dropbox_data:
            instance.dropbox_access_token = dropbox_data.get('access_token')
            instance.dropbox_refresh_token = dropbox_data.get('refresh_token')

        instance.save()
        return instance

class PublicUserSerializer(serializers.ModelSerializer):
    avatar = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ['username', 'first_name', 'last_name', 'bio', 'avatar', 'created_at']

    def get_avatar(self, obj):
        if obj.avatar_s3_location:
            return get_signed_image_url(obj.avatar_s3_location)
        return None