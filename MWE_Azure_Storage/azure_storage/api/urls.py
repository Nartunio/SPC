from django.urls import path
from . import views

urlpatterns = [
    path('upload/', views.upload_file, name='upload_file'),
    path('download/<str:filename>/', views.download_file, name='download_file'),
    path('files/', views.list_files, name='list_files'),

    path('delete/<str:filename>/', views.delete_file, name='delete_file'),
]
