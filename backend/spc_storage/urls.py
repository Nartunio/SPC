from django.urls import path

from . import views

urlpatterns = [
    path('', views.get_files, name='storage-list'),
    path('dirs', views.create_directory, name='storage-create-dir'),
    path('upload', views.upload_file, name='storage-upload'),
    path('item', views.delete_item, name='storage-delete'),
    path('move', views.move_item, name='storage-move'),
    path('download', views.download_link, name='storage-download'),
    path('download-zip', views.download_folder_zip, name='storage-download-zip'),
    path('versions', views.list_versions, name='storage-list-versions'),
    path('versions/restore', views.restore_version, name='storage-restore-version'),
    path('logs', views.list_logs, name='storage-logs'),
    path('share', views.create_share, name='storage-share-create'),
    path('share/list', views.list_owned_shares, name='storage-share-list'),
    path('share/user', views.share_with_user, name='storage-share-user'),
    path('shared', views.list_shared_with_me, name='storage-shared-with-me'),
    path('shared/download', views.shared_download_link, name='storage-shared-download'),
    path('share/revoke', views.revoke_share, name='storage-share-revoke'),
    path('share/access', views.access_share, name='storage-share-access'),
    path('share/download-log', views.log_share_download, name='storage-share-download-log'),
    path('multipart/initiate', views.multipart_initiate, name='storage-multipart-initiate'),
    path('multipart/upload-part', views.multipart_upload_part, name='storage-multipart-upload-part'),
    path('multipart/complete', views.multipart_complete, name='storage-multipart-complete'),
    path('multipart/abort', views.multipart_abort, name='storage-multipart-abort'),
    path('chunked/initiate', views.chunked_initiate, name='storage-chunked-initiate'),
    path('chunked/upload-chunk', views.chunked_upload_chunk, name='storage-chunked-upload-chunk'),
    path('chunked/complete', views.chunked_complete, name='storage-chunked-complete'),
        path('chunked/unfinished', views.chunked_unfinished, name='chunked_unfinished'),
        path('chunked/abort', views.chunked_abort, name='chunked_abort'),
]
