from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/auth/', include('apps.authentication.urls')),
    path('api/users/', include('apps.users.urls')),
    path('api/projects/', include('apps.projects.urls')),
    path('api/ratings/', include('apps.ratings.urls')),
    path('api/dropbox/', include('apps.dropbox_integration.urls')),
    path('health/', include('apps.core.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)