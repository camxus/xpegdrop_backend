from django.urls import path
from . import views

urlpatterns = [
    path('auth-url/', views.get_dropbox_auth_url, name='dropbox_auth_url'),
    path('callback/', views.handle_dropbox_callback, name='dropbox_callback'),
]