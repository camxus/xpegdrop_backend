from django.urls import path
from . import views

urlpatterns = [
    path('', views.ProjectListView.as_view(), name='project_list'),
    path('create/', views.create_project, name='create_project'),
    path('<str:project_id>/', views.ProjectDetailView.as_view(), name='project_detail'),
    path('<str:project_id>/update/', views.ProjectUpdateView.as_view(), name='project_update'),
    path('<str:project_id>/delete/', views.ProjectDeleteView.as_view(), name='project_delete'),
    path('share/<str:username>/<str:project_name>/', views.get_project_by_share_url, name='project_share'),
]