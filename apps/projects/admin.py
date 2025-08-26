from django.contrib import admin
from .models import Project

@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ['name', 'user', 'status', 'is_public', 'created_at']
    list_filter = ['status', 'is_public', 'created_at']
    search_fields = ['name', 'user__username', 'user__email']
    readonly_fields = ['project_id', 'created_at', 'updated_at']
    ordering = ['-created_at']