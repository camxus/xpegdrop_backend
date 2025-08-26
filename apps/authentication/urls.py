from django.urls import path
from . import views

urlpatterns = [
    path('signup/', views.signup, name='signup'),
    path('login/', views.login, name='login'),
    path('refresh-token/', views.refresh_token, name='refresh_token'),
    path('forgot-password/', views.forgot_password, name='forgot_password'),
    path('confirm-password/', views.confirm_password, name='confirm_password'),
    path('set-new-password/', views.set_new_password, name='set_new_password'),
    path('presign-url/', views.get_presign_url, name='get_presign_url'),
    path('presign-post/', views.get_presign_post, name='get_presign_post'),
]