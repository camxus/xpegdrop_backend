from rest_framework import serializers
from .models import Rating

class RatingSerializer(serializers.ModelSerializer):
    user_id = serializers.SerializerMethodField()

    class Meta:
        model = Rating
        fields = ['rating_id', 'project_id', 'user_id', 'image_id', 'value', 'created_at', 'updated_at']
        read_only_fields = ['rating_id', 'created_at', 'updated_at']

    def get_user_id(self, obj):
        return obj.effective_user_id

class CreateRatingSerializer(serializers.Serializer):
    project_id = serializers.CharField()
    image_id = serializers.CharField()
    value = serializers.IntegerField()

class UpdateRatingSerializer(serializers.Serializer):
    value = serializers.IntegerField()