from rest_framework import serializers
from django.contrib.auth import get_user_model

User = get_user_model()

class SignUpSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=30, min_length=3)
    email = serializers.EmailField()
    password = serializers.CharField(min_length=8)
    first_name = serializers.CharField(max_length=50)
    last_name = serializers.CharField(max_length=50)
    bio = serializers.CharField(max_length=500, required=False, allow_blank=True)
    avatar = serializers.JSONField(required=False, allow_null=True)
    dropbox = serializers.JSONField(required=False, allow_null=True)

class SignInSerializer(serializers.Serializer):
    username = serializers.CharField()
    password = serializers.CharField()

class RefreshTokenSerializer(serializers.Serializer):
    refresh_token = serializers.CharField()

class ForgotPasswordSerializer(serializers.Serializer):
    email = serializers.EmailField()

class ConfirmPasswordSerializer(serializers.Serializer):
    email = serializers.EmailField()
    code = serializers.CharField()
    new_password = serializers.CharField(min_length=8)

class SetNewPasswordSerializer(serializers.Serializer):
    email = serializers.EmailField()
    new_password = serializers.CharField(min_length=8)

class PresignURLSerializer(serializers.Serializer):
    bucket = serializers.CharField(required=False, allow_blank=True)
    key = serializers.CharField()
    content_type = serializers.CharField()