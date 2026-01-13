import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError
from django.http import JsonResponse, StreamingHttpResponse
from django.views.decorators.http import require_http_methods
from django.views.decorators.csrf import csrf_exempt
from config import settings
from spc_auth.auth import require_auth
from .models import ActivityLog, FileVersion, StorageShare
from django.utils import timezone
from datetime import timedelta
import os
import io
import zipfile


def _get_s3_client():
    endpoint = settings.S3_ENDPOINT
    access_key = settings.S3_ACCESS_KEY
    secret_key = settings.S3_SECRET_KEY
    region = getattr(settings, "S3_REGION", None)
    session = boto3.session.Session()
    # Normalize endpoint: add https:// if missing and strip trailing slash
    if endpoint and not endpoint.startswith(("http://", "https://")):
        endpoint = f"https://{endpoint}"
    if endpoint:
        endpoint = endpoint.rstrip("/")

    client_kwargs = {
        "endpoint_url": endpoint,
        "aws_access_key_id": access_key,
        "aws_secret_access_key": secret_key,
        "config": BotoConfig(
            signature_version="s3v4",
            s3={
                "payload_signing_enabled": False,
                "addressing_style": "virtual",
            },
        ),
    }
    if region:
        client_kwargs["region_name"] = region
    client = session.client("s3", **client_kwargs)
    return client


@require_auth(None)
@require_http_methods(["GET"])
def get_files(request):
    token = getattr(request, "oauth_token", None)
    if token is None:
        return JsonResponse({"error": "no_token"}, status=401)

    bucket = settings.S3_BUCKET
    if not bucket or not settings.S3_ENDPOINT or not settings.S3_ACCESS_KEY or not settings.S3_SECRET_KEY:
        return JsonResponse({"error": "s3_not_configured"}, status=500)

    claims = dict(token)
    user_prefix = f"{claims['sub']}/"
    logical_path = _sanitize_subpath(request.GET.get("path", "")).rstrip("/")
    current_prefix = f"{user_prefix}{logical_path}/" if logical_path else user_prefix

    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    # Ensure the base prefix exists (root or nested) with a placeholder
    try:
        exists = s3.list_objects_v2(Bucket=bucket, Prefix=current_prefix, MaxKeys=1)
        if exists.get("KeyCount", 0) == 0:
            s3.put_object(Bucket=bucket, Key=current_prefix)
        ActivityLog.objects.create(user_sub=claims['sub'], action="list", key=current_prefix, success=True)
    except ClientError as e:
        ActivityLog.objects.create(user_sub=claims['sub'], action="list", key=current_prefix, success=False, extra={"error": str(e)})
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)

    try:
        resp = s3.list_objects_v2(
            Bucket=bucket,
            Prefix=current_prefix,
            Delimiter="/",
        )
    except ClientError as e:
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)

    directories = []
    for p in resp.get("CommonPrefixes", []):
        prefix = p.get("Prefix", "")
        name = prefix[len(current_prefix):].rstrip("/")
        if name:
            directories.append({"name": name})

    files = []
    for obj in resp.get("Contents", []):
        key = obj.get("Key", "")
        if key.endswith("/"):
            continue
        name = key[len(current_prefix):]
        if "/" in name:
            continue
        files.append({
            "name": name,
            "size": obj.get("Size"),
            "last_modified": obj.get("LastModified").isoformat() if obj.get("LastModified") else None,
            "etag": obj.get("ETag"),
        })

    return JsonResponse({
        "prefix": current_prefix,
        "path": logical_path,
        "directories": directories,
        "files": files,
    })


def _sanitize_subpath(value: str) -> str:
    if not value:
        return ""
    # Normalize separators and strip leading slashes
    path = value.replace("\\", "/").lstrip("/")
    # Remove any .. segments to avoid traversal outside the prefix
    parts = [p for p in path.split("/") if p not in ("", ".") and p != ".."]
    return "/".join(parts)


def _user_prefix_from_request(request) -> str:
    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    return f"{claims['sub']}/"


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def create_directory(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)

    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    user_prefix = _user_prefix_from_request(request)
    claims = dict(getattr(request, "oauth_token", {}))
    body = request.POST or {}
    name = body.get("name") or body.get("path") or ""
    subpath = _sanitize_subpath(name).rstrip("/")
    if not subpath:
        return JsonResponse({"error": "invalid_directory_name"}, status=400)

    key = f"{user_prefix}{subpath}/"
    try:
        # Create all intermediate parent directories
        parts = subpath.split("/")
        for i in range(len(parts)):
            parent_key = f"{user_prefix}{'/'.join(parts[:i+1])}/"
            try:
                exists = s3.list_objects_v2(Bucket=bucket, Prefix=parent_key, MaxKeys=1)
                if exists.get("KeyCount", 0) == 0:
                    s3.put_object(Bucket=bucket, Key=parent_key)
            except ClientError:
                pass
        
        if claims.get('sub'):
            ActivityLog.objects.create(user_sub=claims['sub'], action="create_dir", key=key, success=True)
        return JsonResponse({"created": True, "key": key})
    except ClientError as e:
        if claims.get('sub'):
            ActivityLog.objects.create(user_sub=claims['sub'], action="create_dir", key=key, success=False, extra={"error": str(e)})
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def upload_file(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)

    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    user_prefix = _user_prefix_from_request(request)
    claims = dict(getattr(request, "oauth_token", {}))
    subdir = _sanitize_subpath(request.POST.get("path", "")).rstrip("/")
    if "file" not in request.FILES:
        return JsonResponse({"error": "missing_file"}, status=400)

    file_obj = request.FILES["file"]
    # Enforce 2GB limit for standard uploads
    if hasattr(file_obj, "size") and file_obj.size and file_obj.size > 2 * 1024 * 1024 * 1024:
        return JsonResponse({"error": "file_too_large", "limit": 2 * 1024 * 1024 * 1024}, status=413)
    filename = file_obj.name
    if subdir:
        key = f"{user_prefix}{subdir}/{filename}"
    else:
        key = f"{user_prefix}{filename}"

    try:
        # If key exists, create a version backup before overwrite
        try:
            head = s3.head_object(Bucket=bucket, Key=key)
            # Determine next version
            logical = key[len(user_prefix):]
            latest = FileVersion.objects.filter(owner_sub=claims['sub'], key=logical).order_by("-version").first()
            next_version = (latest.version + 1) if latest else 1
            name, ext = os.path.splitext(key)
            version_key = f"{name}.v{next_version}{ext}"
            s3.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": key}, Key=version_key)
            FileVersion.objects.create(
                owner_sub=claims['sub'], key=logical, version=next_version, object_key=version_key,
                size=head.get("ContentLength"), etag=head.get("ETag")
            )
        except ClientError:
            # Doesn't exist; proceed
            pass

        extra = {"ContentType": getattr(file_obj, "content_type", None) or "application/octet-stream"}
        s3.upload_fileobj(file_obj, bucket, key, ExtraArgs=extra)
        ActivityLog.objects.create(user_sub=claims['sub'], action="upload", key=key, success=True, extra={"size": getattr(file_obj, "size", None)})
        return JsonResponse({"uploaded": True, "key": key})
    except ClientError as e:
        ActivityLog.objects.create(user_sub=claims['sub'], action="upload", key=key, success=False, extra={"error": str(e)})
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@require_auth(None)
@csrf_exempt
@require_http_methods(["DELETE"])
def delete_item(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)

    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    user_prefix = _user_prefix_from_request(request)
    claims = dict(getattr(request, "oauth_token", {}))
    # Support key from query string or form
    raw_key = request.GET.get("key") or request.POST.get("key") or ""
    subkey = _sanitize_subpath(raw_key)
    if not subkey:
        return JsonResponse({"error": "missing_key"}, status=400)

    key = f"{user_prefix}{subkey}"

    try:
        if key.endswith("/"):
            # delete all objects under this prefix (simulate directory delete)
            continuation = None
            deleted = 0
            while True:
                list_kwargs = {"Bucket": bucket, "Prefix": key}
                if continuation:
                    list_kwargs["ContinuationToken"] = continuation
                resp = s3.list_objects_v2(**list_kwargs)
                contents = resp.get("Contents", [])
                if not contents:
                    break
                to_delete = [{"Key": obj["Key"]} for obj in contents]
                s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete})
                deleted += len(to_delete)
                if resp.get("IsTruncated"):
                    continuation = resp.get("NextContinuationToken")
                else:
                    break
            ActivityLog.objects.create(user_sub=claims['sub'], action="delete_prefix", key=key, success=True, extra={"deleted": deleted})
            return JsonResponse({"deleted_prefix": key, "deleted_count": deleted})
        else:
            s3.delete_object(Bucket=bucket, Key=key)
            ActivityLog.objects.create(user_sub=claims['sub'], action="delete", key=key, success=True)
            return JsonResponse({"deleted": True, "key": key})
    except ClientError as e:
        ActivityLog.objects.create(user_sub=claims['sub'], action="delete", key=key, success=False, extra={"error": str(e)})
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def move_item(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)

    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    user_prefix = _user_prefix_from_request(request)
    claims = dict(getattr(request, "oauth_token", {}))
    
    # Get source and destination from POST data (FormData)
    source_key = (request.POST.get("source") or "").strip()
    dest_folder = (request.POST.get("destination") or "").strip()

    # IMPORTANT: _sanitize_subpath removes trailing '/', but we need it to
    # distinguish folders from files (S3 "folder" marker keys end with '/').
    is_directory = source_key.endswith("/")
    source_subkey = _sanitize_subpath(source_key).rstrip("/")
    if is_directory and source_subkey:
        source_subkey = f"{source_subkey}/"

    dest_subpath = _sanitize_subpath(dest_folder).rstrip("/")

    if not source_subkey:
        return JsonResponse({"error": "missing_source"}, status=400)

    source = f"{user_prefix}{source_subkey}"
    
    # Build destination key
    if dest_subpath:
        dest_prefix = f"{user_prefix}{dest_subpath}"
        if not dest_prefix.endswith("/"):
            dest_prefix += "/"
    else:
        dest_prefix = user_prefix
    
    # Extract the item name from source
    item_name = source_subkey.rstrip("/").split("/")[-1]
    destination = f"{dest_prefix}{item_name}{'/' if is_directory else ''}"
    
    # Avoid moving to same location
    if source == destination:
        return JsonResponse({"error": "same_source_destination"}, status=400)

    try:
        if is_directory:
            # Move directory - copy all objects under this prefix
            continuation = None
            moved_count = 0
            failed = []
            while True:
                list_kwargs = {"Bucket": bucket, "Prefix": source}
                if continuation:
                    list_kwargs["ContinuationToken"] = continuation
                resp = s3.list_objects_v2(**list_kwargs)
                contents = resp.get("Contents", [])
                if not contents:
                    break
                
                for obj in contents:
                    old_key = obj["Key"]
                    # Skip folder markers (keys ending with /)
                    if old_key.endswith("/"):
                        continue
                    # Replace prefix (source and destination are both prefixes ending with '/')
                    new_key = old_key.replace(source, destination, 1)
                    # Copy object with error handling
                    try:
                        s3.copy_object(
                            Bucket=bucket,
                            CopySource={"Bucket": bucket, "Key": old_key},
                            Key=new_key
                        )
                        # Delete original only if copy succeeded
                        s3.delete_object(Bucket=bucket, Key=old_key)
                        moved_count += 1
                    except ClientError as copy_error:
                        failed.append({"key": old_key, "error": str(copy_error)})
                        continue
                
                if resp.get("IsTruncated"):
                    continuation = resp.get("NextContinuationToken")
                else:
                    break
            
            # Create destination folder marker
            if not destination.endswith("/"):
                destination = destination + "/"
            try:
                s3.put_object(Bucket=bucket, Key=destination)
            except ClientError:
                pass

            # Delete the source folder marker only when the move fully succeeded.
            # If we had failures, leaving the marker avoids "hiding" objects that
            # remain under the source prefix.

            if failed:
                ActivityLog.objects.create(
                    user_sub=claims['sub'],
                    action="move_prefix_partial",
                    key=source,
                    success=False,
                    extra={
                        "destination": destination,
                        "moved": moved_count,
                        "failed_count": len(failed),
                        "failed": failed[:20],
                    },
                )
                return JsonResponse(
                    {
                        "error": "partial_move",
                        "details": "Some objects could not be moved.",
                        "source": source,
                        "destination": destination,
                        "moved_count": moved_count,
                        "failed_count": len(failed),
                        "failed": failed[:20],
                    },
                    status=409,
                )
            
            ActivityLog.objects.create(
                user_sub=claims['sub'],
                action="move_prefix",
                key=source,
                success=True,
                extra={"destination": destination, "moved": moved_count}
            )

            try:
                s3.delete_object(Bucket=bucket, Key=source)
            except ClientError:
                # If the marker doesn't exist, that's fine.
                pass
            return JsonResponse({"moved": True, "source": source, "destination": destination, "moved_count": moved_count})
        else:
            # Move file
            s3.copy_object(
                Bucket=bucket,
                CopySource={"Bucket": bucket, "Key": source},
                Key=destination
            )
            s3.delete_object(Bucket=bucket, Key=source)
            ActivityLog.objects.create(
                user_sub=claims['sub'],
                action="move",
                key=source,
                success=True,
                extra={"destination": destination}
            )
            return JsonResponse({"moved": True, "source": source, "destination": destination})
    except ClientError as e:
        ActivityLog.objects.create(
            user_sub=claims['sub'],
            action="move",
            key=source,
            success=False,
            extra={"error": str(e), "destination": destination}
        )
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)
    except Exception as e:
        ActivityLog.objects.create(
            user_sub=claims['sub'],
            action="move",
            key=source if 'source' in locals() else "",
            success=False,
            extra={"error": str(e), "type": type(e).__name__}
        )
        return JsonResponse({"error": "server_error", "details": str(e)}, status=500)


@require_auth(None)
@require_http_methods(["GET"])
def download_link(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)

    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    user_prefix = _user_prefix_from_request(request)
    claims = dict(getattr(request, "oauth_token", {}))
    raw_key = request.GET.get("key") or ""
    subkey = _sanitize_subpath(raw_key)
    if not subkey:
        return JsonResponse({"error": "missing_key"}, status=400)

    key = f"{user_prefix}{subkey}"

    try:
        url = s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={
                "Bucket": bucket,
                "Key": key,
                "ResponseContentDisposition": "attachment",
            },
            ExpiresIn=int(request.GET.get("expires", 300)),
        )
        ActivityLog.objects.create(user_sub=claims['sub'], action="download_link", key=key, success=True)
        return JsonResponse({"url": url, "key": key})
    except ClientError as e:
        ActivityLog.objects.create(user_sub=claims['sub'], action="download_link", key=key, success=False, extra={"error": str(e)})
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@require_auth(None)
@require_http_methods(["GET"])
def download_folder_zip(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)

    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    user_prefix = _user_prefix_from_request(request)
    claims = dict(getattr(request, "oauth_token", {}))
    raw_path = request.GET.get("path") or ""
    logical_path = _sanitize_subpath(raw_path).rstrip("/")
    
    if not logical_path:
        return JsonResponse({"error": "invalid_path"}, status=400)

    prefix = f"{user_prefix}{logical_path}/"
    folder_name = logical_path.split("/")[-1] or "folder"

    try:
        def generate_zip():
            with zipfile.ZipFile(io.BytesIO(), mode='w') as zip_buffer:
                zip_buffer = io.BytesIO()
                with zipfile.ZipFile(zip_buffer, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
                    # List all objects under the prefix
                    continuation = None
                    while True:
                        list_kwargs = {"Bucket": bucket, "Prefix": prefix}
                        if continuation:
                            list_kwargs["ContinuationToken"] = continuation
                        resp = s3.list_objects_v2(**list_kwargs)
                        
                        for obj in resp.get("Contents", []):
                            key = obj["Key"]
                            # Skip the folder marker itself
                            if key == prefix:
                                continue
                            # Extract relative path within the folder
                            relative_path = key[len(prefix):]
                            if relative_path:
                                # Get the file content from S3
                                try:
                                    file_obj = s3.get_object(Bucket=bucket, Key=key)
                                    file_content = file_obj['Body'].read()
                                    zf.writestr(relative_path, file_content)
                                except ClientError:
                                    pass
                        
                        if resp.get("IsTruncated"):
                            continuation = resp.get("NextContinuationToken")
                        else:
                            break
                
                zip_buffer.seek(0)
                yield zip_buffer.getvalue()

        ActivityLog.objects.create(user_sub=claims['sub'], action="download_folder_zip", key=prefix, success=True)
        response = StreamingHttpResponse(generate_zip(), content_type='application/zip')
        response['Content-Disposition'] = f'attachment; filename="{folder_name}.zip"'
        return response
    except ClientError as e:
        ActivityLog.objects.create(user_sub=claims['sub'], action="download_folder_zip", key=prefix, success=False, extra={"error": str(e)})
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@require_auth(None)
@require_http_methods(["GET"])
def list_versions(request):
    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    raw_key = request.GET.get("key") or ""
    logical = _sanitize_subpath(raw_key)
    if not logical:
        return JsonResponse({"error": "missing_key"}, status=400)
    versions = FileVersion.objects.filter(owner_sub=claims['sub'], key=logical).order_by("-version")
    data = [
        {"version": v.version, "object_key": v.object_key, "size": v.size, "etag": v.etag, "created_at": v.created_at.isoformat()}
        for v in versions
    ]
    return JsonResponse({"key": logical, "versions": data})


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def restore_version(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)

    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    logical = _sanitize_subpath(request.POST.get("key", ""))
    version = request.POST.get("version")
    if not logical or not version:
        return JsonResponse({"error": "missing_params"}, status=400)
    try:
        ver = int(version)
    except ValueError:
        return JsonResponse({"error": "invalid_version"}, status=400)

    fv = FileVersion.objects.filter(owner_sub=claims['sub'], key=logical, version=ver).first()
    if not fv:
        return JsonResponse({"error": "version_not_found"}, status=404)

    user_prefix = f"{claims['sub']}/"
    current_key = f"{user_prefix}{logical}"
    try:
        s3.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": fv.object_key}, Key=current_key)
        ActivityLog.objects.create(user_sub=claims['sub'], action="restore_version", key=current_key, success=True, extra={"version": ver})
        return JsonResponse({"restored": True, "key": current_key, "version": ver})
    except ClientError as e:
        ActivityLog.objects.create(user_sub=claims['sub'], action="restore_version", key=current_key, success=False, extra={"error": str(e)})
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@require_auth(None)
@require_http_methods(["GET"])
def list_logs(request):
    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    limit = int(request.GET.get("limit", 50))
    logs = ActivityLog.objects.filter(user_sub=claims['sub']).order_by("-created_at")[: max(1, min(200, limit))]
    data = [
        {"action": l.action, "key": l.key, "success": l.success, "created_at": l.created_at.isoformat(), "extra": l.extra}
        for l in logs
    ]
    return JsonResponse({"logs": data})


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def share_with_user(request):
    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    key = _sanitize_subpath(request.POST.get("key", ""))
    target_sub = request.POST.get("target_sub")
    permission = request.POST.get("permission", "read")
    expires_in = request.POST.get("expires_in")
    if not key or not target_sub:
        return JsonResponse({"error": "missing_params"}, status=400)
    is_dir = key.endswith("/")
    expires_at = None
    if expires_in:
        try:
            seconds = int(expires_in)
            expires_at = timezone.now() + timedelta(seconds=seconds)
        except ValueError:
            pass
    share = StorageShare.objects.create(
        owner_sub=claims['sub'], target_sub=target_sub, key=key, is_directory=is_dir, permission=permission, expires_at=expires_at
    )
    ActivityLog.objects.create(user_sub=claims['sub'], action="share_create", key=key, success=True, extra={"target_sub": target_sub})
    return JsonResponse({"share_id": str(share.id), "key": key, "target_sub": target_sub, "permission": permission, "expires_at": share.expires_at.isoformat() if share.expires_at else None})


@require_auth(None)
@require_http_methods(["GET"])
def list_shared_with_me(request):
    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    now = timezone.now()
    shares = StorageShare.objects.filter(target_sub=claims['sub']).filter(models.Q(expires_at__isnull=True) | models.Q(expires_at__gt=now))
    data = [
        {"share_id": str(s.id), "owner_sub": s.owner_sub, "key": s.key, "is_directory": s.is_directory, "permission": s.permission, "expires_at": s.expires_at.isoformat() if s.expires_at else None}
        for s in shares
    ]
    return JsonResponse({"shares": data})


@require_auth(None)
@csrf_exempt
@require_http_methods(["DELETE"])
def revoke_share(request):
    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    share_id = request.GET.get("share_id") or request.POST.get("share_id")
    if not share_id:
        return JsonResponse({"error": "missing_share_id"}, status=400)
    share = StorageShare.objects.filter(id=share_id, owner_sub=claims['sub']).first()
    if not share:
        return JsonResponse({"error": "not_found"}, status=404)
    key = share.key
    share.delete()
    ActivityLog.objects.create(user_sub=claims['sub'], action="share_revoke", key=key, success=True)
    return JsonResponse({"revoked": True, "share_id": share_id})


@require_auth(None)
@require_http_methods(["GET"])
def shared_download_link(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)
    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    share_id = request.GET.get("share_id")
    if not share_id:
        return JsonResponse({"error": "missing_share_id"}, status=400)
    share = StorageShare.objects.filter(id=share_id, target_sub=claims['sub']).first()
    if not share:
        return JsonResponse({"error": "not_found"}, status=404)
    if share.expires_at and share.expires_at <= timezone.now():
        return JsonResponse({"error": "share_expired"}, status=403)

    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    owner_prefix = f"{share.owner_sub}/"
    key = f"{owner_prefix}{share.key}"
    if key.endswith("/"):
        return JsonResponse({"error": "cannot_download_directory"}, status=400)
    try:
        url = s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=int(request.GET.get("expires", 300)),
        )
        return JsonResponse({"url": url, "key": key})
    except ClientError as e:
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def multipart_initiate(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)
    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    user_prefix = f"{claims['sub']}/"
    subdir = _sanitize_subpath(request.POST.get("path", "")).rstrip("/")
    filename = request.POST.get("filename")
    total_size = request.POST.get("total_size")
    if not filename:
        return JsonResponse({"error": "missing_filename"}, status=400)
    if total_size:
        try:
            if int(total_size) > 2 * 1024 * 1024 * 1024:
                return JsonResponse({"error": "file_too_large", "limit": 2 * 1024 * 1024 * 1024}, status=413)
        except ValueError:
            pass
    key = f"{user_prefix}{subdir + '/' if subdir else ''}{filename}"

    # Version backup if exists
    try:
        head = s3.head_object(Bucket=bucket, Key=key)
        logical = key[len(user_prefix):]
        latest = FileVersion.objects.filter(owner_sub=claims['sub'], key=logical).order_by("-version").first()
        next_version = (latest.version + 1) if latest else 1
        name, ext = os.path.splitext(key)
        version_key = f"{name}.v{next_version}{ext}"
        s3.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": key}, Key=version_key)
        FileVersion.objects.create(owner_sub=claims['sub'], key=logical, version=next_version, object_key=version_key, size=head.get("ContentLength"), etag=head.get("ETag"))
    except ClientError:
        pass

    resp = s3.create_multipart_upload(Bucket=bucket, Key=key)
    upload_id = resp.get("UploadId")
    return JsonResponse({"uploadId": upload_id, "key": key})


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def multipart_upload_part(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)
    key = request.POST.get("key")
    upload_id = request.POST.get("uploadId")
    part_number = request.POST.get("partNumber")
    if not key or not upload_id or not part_number:
        return JsonResponse({"error": "missing_params"}, status=400)
    try:
        part_no = int(part_number)
    except ValueError:
        return JsonResponse({"error": "invalid_part_number"}, status=400)
    body = request.FILES.get("chunk") or request.body
    if not body:
        return JsonResponse({"error": "missing_chunk"}, status=400)
    try:
        resp = s3.upload_part(Bucket=bucket, Key=key, PartNumber=part_no, UploadId=upload_id, Body=body)
        etag = resp.get("ETag")
        return JsonResponse({"partNumber": part_no, "etag": etag})
    except ClientError as e:
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def multipart_complete(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)
    key = request.POST.get("key")
    upload_id = request.POST.get("uploadId")
    # parts come as JSON string or repeated form fields; accept simple JSON
    import json as _json
    parts_json = request.POST.get("parts")
    if not key or not upload_id or not parts_json:
        return JsonResponse({"error": "missing_params"}, status=400)
    try:
        parts = _json.loads(parts_json)
    except Exception:
        return JsonResponse({"error": "invalid_parts"}, status=400)
    try:
        resp = s3.complete_multipart_upload(
            Bucket=bucket,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={"Parts": [{"ETag": p["etag"], "PartNumber": p["partNumber"]} for p in parts]},
        )
        return JsonResponse({"completed": True, "location": resp.get("Location"), "etag": resp.get("ETag")})
    except ClientError as e:
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def multipart_abort(request):
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)
    key = request.POST.get("key")
    upload_id = request.POST.get("uploadId")
    if not key or not upload_id:
        return JsonResponse({"error": "missing_params"}, status=400)
    try:
        s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
        return JsonResponse({"aborted": True})
    except ClientError as e:
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)