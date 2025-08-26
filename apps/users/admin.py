from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from .models import User

@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ['username', 'email', 'first_name', 'last_name', 'created_at']
    list_filter = ['created_at', 'updated_at']
    search_fields = ['username', 'email', 'first_name', 'last_name']
    ordering = ['-created_at']
    
    fieldsets = BaseUserAdmin.fieldsets + (
        ('Additional Info', {
            'fields': ('user_id', 'bio', 'avatar_bucket', 'avatar_key', 
                      'dropbox_access_token', 'dropbox_refresh_token')
        }),
    )
    
    readonly_fields = ['user_id', 'created_at', 'updated_at']