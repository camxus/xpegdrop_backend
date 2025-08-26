from django.urls import path
from . import views

urlpatterns = [
    path('', views.CurrentUserView.as_view(), name='current_user'),
    path('<str:user_id>/', views.UserDetailView.as_view(), name='user_detail'),
    path('update/', views.UserUpdateView.as_view(), name='user_update'),
    path('delete/', views.UserDeleteView.as_view(), name='user_delete'),
    path('username/<str:username>/', views.get_user_by_username, name='user_by_username'),
    path('dropbox-token/', views.update_dropbox_token, name='update_dropbox_token'),
]