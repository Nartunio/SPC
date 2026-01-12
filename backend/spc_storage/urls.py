from django.urls import path

from . import views

urlpatterns = [
    path('', views.get_files, name='storage-list'),
    path('dirs', views.create_directory, name='storage-create-dir'),
    path('upload', views.upload_file, name='storage-upload'),
    path('item', views.delete_item, name='storage-delete'),
    path('download', views.download_link, name='storage-download'),
    path('versions', views.list_versions, name='storage-list-versions'),
    path('versions/restore', views.restore_version, name='storage-restore-version'),
    path('logs', views.list_logs, name='storage-logs'),
    path('share/user', views.share_with_user, name='storage-share-user'),
    path('shared', views.list_shared_with_me, name='storage-shared-with-me'),
    path('shared/download', views.shared_download_link, name='storage-shared-download'),
    path('share', views.revoke_share, name='storage-share-revoke'),
    path('multipart/initiate', views.multipart_initiate, name='storage-multipart-initiate'),
    path('multipart/upload-part', views.multipart_upload_part, name='storage-multipart-upload-part'),
    path('multipart/complete', views.multipart_complete, name='storage-multipart-complete'),
    path('multipart/abort', views.multipart_abort, name='storage-multipart-abort'),
]
