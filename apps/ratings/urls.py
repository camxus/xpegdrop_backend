from django.urls import path
from . import views

urlpatterns = [
    path('', views.create_rating, name='create_rating'),
    path('<str:project_id>/', views.get_ratings, name='get_ratings'),
    path('<str:rating_id>/update/', views.update_rating, name='update_rating'),
    path('<str:rating_id>/delete/', views.delete_rating, name='delete_rating'),
]