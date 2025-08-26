from django.contrib import admin
from .models import Rating

@admin.register(Rating)
class RatingAdmin(admin.ModelAdmin):
    list_display = ['rating_id', 'project_id', 'image_id', 'value', 'user_id_anonymous', 'created_at']
    list_filter = ['value', 'created_at']
    search_fields = ['project_id', 'image_id', 'user_id_anonymous']
    readonly_fields = ['rating_id', 'created_at', 'updated_at']
    ordering = ['-created_at']