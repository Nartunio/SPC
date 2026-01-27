import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError
from django.http import JsonResponse, StreamingHttpResponse, HttpResponseRedirect, HttpResponse
from django.views.decorators.http import require_http_methods
from django.views.decorators.csrf import csrf_exempt
from config import settings
from config.validator import Auth0JWTBearerTokenValidator
from spc_auth.auth import require_auth, token_validator
from .models import ActivityLog, FileVersion, StorageShare
from spc_auth.models import UserIdentity
from django.db import models
from typing import Optional
from django.utils import timezone
from datetime import timedelta, datetime
import os
import io
import zipfile
import json
import time
import hashlib
import re
import urllib.request
import urllib.parse


FRONTEND_SHARE_BASE = (
    getattr(settings, "FRONTEND_SHARE_BASE", None)
    or getattr(settings, "FRONTEND_ORIGIN", None)
    or ("http://localhost:5173" if getattr(settings, "DEBUG", False) else None)
)

_AUTH0_MGMT_CACHE = {"token": None, "expires_at": 0.0}
_ID_TOKEN_VALIDATOR = None


def _user_root_prefix(sub: str) -> str:
    # User storage root lives at: <sub>/root/
    # All logical paths are relative to this prefix.
    return f"{sub}/root/"


def _user_chunks_prefix(sub: str) -> str:
    # Chunk staging lives at: <sub>/chunks/
    # This is intentionally outside <sub>/root/ so it doesn't appear as a user folder.
    return f"{sub}/chunks/"


_HEX_64_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def _is_sha256_hex(value: str) -> bool:
    if not value:
        return False
    return bool(_HEX_64_RE.match(str(value).strip()))


def _delete_s3_prefix(s3, bucket: str, prefix: str) -> int:
    """Delete all objects under a prefix. Returns number of deleted objects (best-effort)."""
    deleted = 0
    continuation = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if continuation:
            kwargs["ContinuationToken"] = continuation
        resp = s3.list_objects_v2(**kwargs)
        contents = resp.get("Contents", []) or []
        if not contents:
            break
        keys = [{"Key": obj.get("Key")} for obj in contents if obj.get("Key")]
        # S3 delete_objects allows up to 1000 per request.
        for i in range(0, len(keys), 1000):
            batch = keys[i:i + 1000]
            if not batch:
                continue
            s3.delete_objects(Bucket=bucket, Delete={"Objects": batch})
            deleted += len(batch)
        if resp.get("IsTruncated"):
            continuation = resp.get("NextContinuationToken")
        else:
            break
    return deleted


def _id_token_validator() -> Optional[Auth0JWTBearerTokenValidator]:
    global _ID_TOKEN_VALIDATOR
    if _ID_TOKEN_VALIDATOR is not None:
        return _ID_TOKEN_VALIDATOR
    domain = getattr(settings, "AUTH0_DOMAIN", None)
    client_id = getattr(settings, "AUTH0_CLIENT_ID", None)
    if not domain or not client_id:
        _ID_TOKEN_VALIDATOR = None
        return _ID_TOKEN_VALIDATOR
    try:
        _ID_TOKEN_VALIDATOR = Auth0JWTBearerTokenValidator(domain, client_id)
        return _ID_TOKEN_VALIDATOR
    except Exception:
        _ID_TOKEN_VALIDATOR = None
        return _ID_TOKEN_VALIDATOR


def _auth0_domain_url() -> Optional[str]:
    domain = getattr(settings, "AUTH0_DOMAIN", None)
    if not domain:
        return None
    if domain.startswith("http://") or domain.startswith("https://"):
        return domain.rstrip("/")
    return f"https://{domain.rstrip('/')}"


def _auth0_management_token() -> Optional[str]:
    """Fetch an Auth0 Management API token (client credentials)."""
    now = time.time()
    if _AUTH0_MGMT_CACHE.get("token") and now < float(_AUTH0_MGMT_CACHE.get("expires_at", 0)) - 60:
        return _AUTH0_MGMT_CACHE["token"]

    base = _auth0_domain_url()
    client_id = getattr(settings, "AUTH0_CLIENT_ID", None)
    client_secret = getattr(settings, "AUTH0_CLIENT_SECRET", None)
    if not base or not client_id or not client_secret:
        return None

    payload = json.dumps({
        "client_id": client_id,
        "client_secret": client_secret,
        "audience": f"{base}/api/v2/",
        "scope": "read:users",
        "grant_type": "client_credentials",
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{base}/oauth/token",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            token = data.get("access_token")
            expires_in = int(data.get("expires_in", 0) or 0)
            if token and expires_in:
                _AUTH0_MGMT_CACHE["token"] = token
                _AUTH0_MGMT_CACHE["expires_at"] = now + expires_in
            return token
    except Exception:
        return None


def _auth0_user_email_by_sub(user_sub: str) -> Optional[str]:
    base = _auth0_domain_url()
    token = _auth0_management_token()
    if not base or not token or not user_sub:
        return None
    user_id = urllib.parse.quote(user_sub, safe="")
    req = urllib.request.Request(
        f"{base}/api/v2/users/{user_id}",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            email = data.get("email")
            if isinstance(email, str) and email:
                return email.lower()
            return None
    except Exception:
        return None


def _auth0_user_sub_by_email(email: str) -> Optional[str]:
    """Resolve an Auth0 user_id (sub) from an email via Management API."""
    base = _auth0_domain_url()
    token = _auth0_management_token()
    if not base or not token or not email:
        return None
    query = urllib.parse.urlencode({"email": email})
    req = urllib.request.Request(
        f"{base}/api/v2/users-by-email?{query}",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if isinstance(data, list) and data:
                user_id = data[0].get("user_id")
                if isinstance(user_id, str) and user_id:
                    return user_id
            return None
    except Exception:
        return None


def _parse_allowed_emails(raw: str):
    if not raw:
        return []
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return [str(e).strip().lower() for e in data if str(e).strip()]
    except Exception:
        pass
    # fallback: comma or newline separated
    parts = [p.strip() for p in raw.replace("\n", ",").split(",") if p.strip()]
    return [p.lower() for p in parts]


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


def _key_exists(s3, bucket: str, key: str) -> bool:
    """Return True if the exact key exists in S3."""
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("404", "NotFound"):
            return False
        raise


def _prefix_exists(s3, bucket: str, prefix: str) -> bool:
    """Return True if there is at least one object (or marker) under the prefix."""
    resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1)
    return resp.get("KeyCount", 0) > 0


def _is_prefix_empty(s3, bucket: str, prefix: str) -> bool:
    """Heuristically determine if a prefix has no children besides its own marker."""
    try:
        resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=2)
        count = resp.get("KeyCount", 0)
        if count == 0:
            return True
        if count == 1:
            contents = resp.get("Contents", [])
            if contents:
                only_key = contents[0].get("Key")
                if only_key == prefix:
                    return True
        return False
    except ClientError:
        # If we cannot determine, err on the side of treating it as non-empty so download remains available.
        return False


def _zip_prefix_to_bytes(s3, bucket: str, prefix: str) -> bytes:
    """Create an in-memory zip for all objects under the prefix (excluding marker)."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
        continuation = None
        while True:
            list_kwargs = {"Bucket": bucket, "Prefix": prefix}
            if continuation:
                list_kwargs["ContinuationToken"] = continuation
            resp = s3.list_objects_v2(**list_kwargs)
            for obj in resp.get("Contents", []):
                key = obj.get("Key")
                if not key or key == prefix:
                    continue
                relative_path = key[len(prefix):]
                if not relative_path:
                    continue
                try:
                    file_obj = s3.get_object(Bucket=bucket, Key=key)
                    zf.writestr(relative_path, file_obj['Body'].read())
                except ClientError:
                    # skip unreadable objects but keep building zip
                    continue
            if resp.get("IsTruncated"):
                continuation = resp.get("NextContinuationToken")
            else:
                break
    buffer.seek(0)
    return buffer.getvalue()


def _key_or_prefix_exists(s3, bucket: str, full_key: str) -> bool:
    if full_key.endswith("/"):
        return _prefix_exists(s3, bucket, full_key)
    return _key_exists(s3, bucket, full_key)


def _optional_claims(request):
    auth_header = request.META.get("HTTP_AUTHORIZATION") or request.headers.get("Authorization")
    if not auth_header or not auth_header.lower().startswith("bearer "):
        return None
    token_str = auth_header.split(" ", 1)[1]
    try:
        token = token_validator.authenticate_token(token_str)
        return dict(token)
    except Exception:
        return None


def _optional_id_token_claims(request):
    """Validate an Auth0 ID token passed via header.

    Frontend sends this so we can reliably extract email/sub even when the API
    access token lacks an email claim.
    """
    raw = (
        request.META.get("HTTP_X_AUTH0_ID_TOKEN")
        or request.headers.get("X-Auth0-Id-Token")
        or request.headers.get("x-auth0-id-token")
    )
    if not raw:
        return None
    raw = raw.strip()
    if raw.lower().startswith("bearer "):
        raw = raw.split(" ", 1)[1].strip()

    validator = _id_token_validator()
    if not validator:
        return None
    try:
        token = validator.authenticate_token(raw)
        return dict(token)
    except Exception:
        return None


def _optional_frontend_email(request) -> Optional[dict]:
    """DEV ONLY: accept email from frontend, guarded by matching sub.

    This is a pragmatic fallback when Auth0 access tokens do not include email and
    ID token isn't available. Only used when DEBUG=True.
    """
    if not getattr(settings, "DEBUG", False):
        return None
    email = (
        request.META.get("HTTP_X_AUTH0_USER_EMAIL")
        or request.headers.get("X-Auth0-User-Email")
        or request.headers.get("x-auth0-user-email")
    )
    sub = (
        request.META.get("HTTP_X_AUTH0_USER_SUB")
        or request.headers.get("X-Auth0-User-Sub")
        or request.headers.get("x-auth0-user-sub")
    )
    if not email or not sub:
        return None
    email = str(email).strip().lower()
    sub = str(sub).strip()
    if not email or "@" not in email:
        return None
    if not sub or "|" not in sub:
        return None
    return {"email": email, "sub": sub}


def _extract_email_from_claims(claims):
    if not claims:
        return None
    email = claims.get("email") or claims.get("emails")
    if isinstance(email, list):
        email = email[0] if email else None
    if isinstance(email, str) and email:
        return email.lower()
    # Look for any namespaced email claim
    for key, value in claims.items():
        if not isinstance(key, str):
            continue
        if "email" in key.lower():
            if isinstance(value, list):
                candidate = value[0] if value else None
            else:
                candidate = value
            if isinstance(candidate, str) and candidate:
                return candidate.lower()
    return None


def _record_identity(claims):
    if not claims:
        return
    email = claims.get("email")
    sub = claims.get("sub")
    if not email or not sub:
        return
    email_l = str(email).lower()
    try:
        UserIdentity.objects.get_or_create(sub=sub, defaults={"email": email_l})
    except Exception:
        pass


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
    user_prefix = _user_root_prefix(claims['sub'])
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

    # Best-effort actor email resolution (used as a fallback for created_by_email).
    _record_identity(claims)
    actor_email = (_extract_email_from_claims(claims) or "").strip().lower()
    if not actor_email:
        try:
            ident = UserIdentity.objects.filter(sub=claims['sub']).first()
            if ident and ident.email:
                actor_email = str(ident.email).strip().lower()
        except Exception:
            pass
    if not actor_email:
        actor_email = "anonymous"

    directories = []
    for p in resp.get("CommonPrefixes", []):
        prefix = p.get("Prefix", "")
        name = prefix[len(current_prefix):].rstrip("/")
        if name:
            directories.append({
                "name": name,
                "is_empty": _is_prefix_empty(s3, bucket, prefix),
            })

    # Best-effort folder metadata (based on ActivityLog timestamps for keys under the folder prefix).
    for d in directories:
        folder_prefix = f"{current_prefix}{d.get('name', '')}/"
        created_at = None
        last_modified = None
        created_by_email = None
        try:
            # If the folder (prefix) was deleted at some point, ignore logs before the last delete.
            delete_cutoff = (
                ActivityLog.objects.filter(
                    user_sub=claims['sub'],
                    action="delete_prefix",
                    success=True,
                    key=folder_prefix,
                )
                .only("created_at")
                .order_by("-created_at")
                .first()
            )
            cutoff_ts = delete_cutoff.created_at if delete_cutoff else None

            base_folder_qs = ActivityLog.objects.filter(
                user_sub=claims['sub'],
                success=True,
                key__startswith=folder_prefix,
            ).exclude(action="list")
            if cutoff_ts:
                base_folder_qs = base_folder_qs.filter(created_at__gt=cutoff_ts)

            earliest = (
                base_folder_qs
                .only("created_at", "extra")
                .order_by("created_at")
                .first()
            )
            latest = (
                base_folder_qs
                .only("created_at")
                .order_by("-created_at")
                .first()
            )
            if earliest:
                extra = (earliest.extra or {}) if hasattr(earliest, "extra") else {}
                origin = extra.get("origin_created_at")
                created_by_email = extra.get("origin_created_by_email") or extra.get("uploader_email")
                if isinstance(origin, str) and origin:
                    try:
                        created_at = datetime.fromisoformat(origin.replace("Z", "+00:00"))
                        if timezone.is_naive(created_at):
                            created_at = timezone.make_aware(created_at, timezone.get_current_timezone())
                    except Exception:
                        created_at = earliest.created_at
                else:
                    created_at = earliest.created_at
            if latest:
                last_modified = latest.created_at
        except Exception:
            created_at = None
            last_modified = None
            created_by_email = None

        d["created_at"] = created_at.isoformat() if created_at else None
        d["last_modified"] = last_modified.isoformat() if last_modified else None
        d["created_by_email"] = (str(created_by_email).strip().lower() if created_at and isinstance(created_by_email, str) and created_by_email else actor_email) if created_at else None

    files = []
    file_keys: list[str] = []
    for obj in resp.get("Contents", []):
        key = obj.get("Key", "")
        if key.endswith("/"):
            continue
        name = key[len(current_prefix):]
        if "/" in name:
            continue
        file_keys.append(key)
        files.append({
            "name": name,
            "size": obj.get("Size"),
            "last_modified": obj.get("LastModified").isoformat() if obj.get("LastModified") else None,
            "etag": obj.get("ETag"),
        })

    # Best-effort creation time + creator: first successful upload log for the exact key.
    # For chunked uploads we log on finalize as action="upload_chunked", so include it.
    created_at_by_key: dict[str, datetime] = {}
    created_by_email_by_key: dict[str, str] = {}
    if file_keys:
        try:
            created_qs = (
                ActivityLog.objects.filter(
                    user_sub=claims['sub'],
                    action__in=["upload", "upload_chunked"],
                    success=True,
                    key__in=file_keys,
                )
                .only("key", "created_at", "extra")
                .order_by("created_at")
            )
            for l in created_qs:
                if l.key and l.key not in created_at_by_key:
                    created_at_by_key[str(l.key)] = l.created_at
                    extra = (l.extra or {}) if hasattr(l, "extra") else {}
                    uploader = extra.get("uploader_email")
                    if isinstance(uploader, str) and uploader.strip():
                        created_by_email_by_key[str(l.key)] = uploader.strip().lower()
        except Exception:
            created_at_by_key = {}
            created_by_email_by_key = {}

    # If files were renamed/moved, fall back to origin_created_at from move logs keyed by the *current* key.
    origin_created_at_by_key: dict[str, str] = {}
    origin_created_by_email_by_key: dict[str, str] = {}
    missing_file_keys = [k for k in file_keys if k not in created_at_by_key]
    if missing_file_keys:
        try:
            move_qs = (
                ActivityLog.objects.filter(
                    user_sub=claims['sub'],
                    action="move",
                    success=True,
                    key__in=missing_file_keys,
                )
                .only("key", "created_at", "extra")
                .order_by("-created_at")
            )
            for l in move_qs:
                if not l.key:
                    continue
                if str(l.key) in origin_created_at_by_key:
                    continue
                extra = l.extra or {}
                oc = extra.get("origin_created_at")
                if isinstance(oc, str) and oc:
                    origin_created_at_by_key[str(l.key)] = oc
                ob = extra.get("origin_created_by_email")
                if isinstance(ob, str) and ob:
                    origin_created_by_email_by_key[str(l.key)] = ob.strip().lower()
        except Exception:
            origin_created_at_by_key = {}
            origin_created_by_email_by_key = {}

    # Attach metadata per returned file.
    if created_at_by_key:
        for f in files:
            full_key = f"{current_prefix}{f.get('name', '')}"
            dt = created_at_by_key.get(full_key)
            if dt:
                f["created_at"] = dt.isoformat()
                f["created_by_email"] = created_by_email_by_key.get(full_key) or actor_email
            else:
                origin = origin_created_at_by_key.get(full_key)
                f["created_at"] = origin or None
                f["created_by_email"] = origin_created_by_email_by_key.get(full_key) if origin else None
    else:
        for f in files:
            full_key = f"{current_prefix}{f.get('name', '')}"
            origin = origin_created_at_by_key.get(full_key)
            f["created_at"] = origin or None
            f["created_by_email"] = origin_created_by_email_by_key.get(full_key) if origin else None

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
    return _user_root_prefix(claims['sub'])


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
            logical = key[len(user_prefix):]
            latest = FileVersion.objects.filter(owner_sub=claims['sub'], key=logical).order_by("-version").first()
            next_version = (latest.version + 1) if latest else 1
            name, ext = os.path.splitext(key)
            version_key = f"{name}.v{next_version}{ext}"
            s3.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": key}, Key=version_key)
            FileVersion.objects.create(
                owner_sub=claims['sub'],
                key=logical,
                version=next_version,
                object_key=version_key,
                size=head.get("ContentLength"),
                etag=head.get("ETag"),
            )
        except ClientError:
            # Doesn't exist; proceed
            pass

        extra = {"ContentType": getattr(file_obj, "content_type", None) or "application/octet-stream"}
        s3.upload_fileobj(file_obj, bucket, key, ExtraArgs=extra)

        uploader_email = (_extract_email_from_claims(claims) or "").strip().lower()
        if not uploader_email:
            try:
                ident = UserIdentity.objects.filter(sub=claims.get('sub')).first()
                if ident and ident.email:
                    uploader_email = str(ident.email).strip().lower()
            except Exception:
                uploader_email = ""

        ActivityLog.objects.create(
            user_sub=claims['sub'],
            action="upload",
            key=key,
            success=True,
            extra={"size": getattr(file_obj, "size", None), "uploader_email": uploader_email or None},
        )
        return JsonResponse({"uploaded": True, "key": key})
    except ClientError as e:
        ActivityLog.objects.create(user_sub=claims['sub'], action="upload", key=key, success=False, extra={"error": str(e)})
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
    new_name_raw = (request.POST.get("new_name") or "").strip()

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
    
    # Optional rename support
    item_name_override = None
    if new_name_raw:
        new_name = _sanitize_subpath(new_name_raw)
        # Reject names that resolve to nested paths
        if not new_name or "/" in new_name:
            return JsonResponse({"error": "invalid_new_name"}, status=400)
        item_name_override = new_name

    # Build destination key
    if dest_subpath:
        dest_prefix = f"{user_prefix}{dest_subpath}"
        if not dest_prefix.endswith("/"):
            dest_prefix += "/"
    else:
        dest_prefix = user_prefix
    
    # Extract the item name from source
    old_name = source_subkey.rstrip("/").split("/")[-1]
    item_name = item_name_override or old_name
    destination = f"{dest_prefix}{item_name}{'/' if is_directory else ''}"

    # Relative (logical) paths for logging/UI (no user_prefix leakage)
    destination_rel = destination[len(user_prefix):] if destination.startswith(user_prefix) else destination
    if not is_directory:
        source_rel = source_subkey.rstrip("/")
        destination_rel = destination_rel.rstrip("/")
    else:
        source_rel = source_subkey if source_subkey.endswith("/") else f"{source_subkey.rstrip('/')}/"
        destination_rel = destination_rel if destination_rel.endswith("/") else f"{destination_rel.rstrip('/')}/"

    is_rename = bool(item_name_override) and old_name != item_name
    
    # Avoid moving to same location
    if source == destination:
        return JsonResponse({"error": "same_source_destination"}, status=400)

    # Best-effort: preserve original creation timestamp across moves/renames.
    origin_created_at: Optional[str] = None
    origin_created_by_email: Optional[str] = None
    try:
        if is_directory:
            # Earliest successful non-list activity under the source prefix.
            earliest = (
                ActivityLog.objects.filter(
                    user_sub=claims['sub'],
                    success=True,
                    key__startswith=source,
                )
                .exclude(action="list")
                .only("created_at", "extra")
                .order_by("created_at")
                .first()
            )
            if earliest and earliest.created_at:
                origin_created_at = earliest.created_at.isoformat()
                try:
                    extra = (earliest.extra or {}) if hasattr(earliest, "extra") else {}
                    ocb = extra.get("origin_created_by_email") or extra.get("uploader_email")
                    if isinstance(ocb, str) and ocb.strip():
                        origin_created_by_email = ocb.strip().lower()
                except Exception:
                    origin_created_by_email = None
        else:
            earliest = (
                ActivityLog.objects.filter(
                    user_sub=claims['sub'],
                    success=True,
                    action__in=["upload", "upload_chunked"],
                    key=source,
                )
                .only("created_at", "extra")
                .order_by("created_at")
                .first()
            )
            if earliest and earliest.created_at:
                origin_created_at = earliest.created_at.isoformat()
                try:
                    extra = (earliest.extra or {}) if hasattr(earliest, "extra") else {}
                    ocb = extra.get("uploader_email")
                    if isinstance(ocb, str) and ocb.strip():
                        origin_created_by_email = ocb.strip().lower()
                except Exception:
                    origin_created_by_email = None
    except Exception:
        origin_created_at = None
        origin_created_by_email = None

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
                    # Replace prefix (source and destination are both prefixes ending with '/')
                    new_key = old_key.replace(source, destination, 1)

                    # Folder markers: recreate marker at destination, then delete old marker
                    if old_key.endswith("/"):
                        try:
                            s3.put_object(Bucket=bucket, Key=new_key)
                            s3.delete_object(Bucket=bucket, Key=old_key)
                        except ClientError as copy_error:
                            failed.append({"key": old_key, "error": str(copy_error)})
                        continue

                    # Regular objects: copy then delete
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
                extra={
                    "destination": destination_rel,
                    "from": source_rel,
                    "to": destination_rel,
                    "moved": moved_count,
                    "origin_created_at": origin_created_at,
                    "origin_created_by_email": origin_created_by_email,
                    "old_name": old_name,
                    "new_name": item_name,
                    "rename": is_rename,
                }
            )

            # Also log the destination so folder metadata works after rename/move.
            try:
                ActivityLog.objects.create(
                    user_sub=claims['sub'],
                    action="move_prefix",
                    key=destination,
                    success=True,
                    extra={
                        "source": source_rel,
                        "from": source_rel,
                        "to": destination_rel,
                        "moved": moved_count,
                        "origin_created_at": origin_created_at,
                        "origin_created_by_email": origin_created_by_email,
                        "old_name": old_name,
                        "new_name": item_name,
                        "rename": is_rename,
                    },
                )
            except Exception:
                pass

            # Keep shares in sync (only when the move fully succeeded)
            try:
                src_rel = source_subkey
                dst_rel = destination[len(user_prefix):]
                if not src_rel.endswith("/"):
                    src_rel = f"{src_rel.rstrip('/')}/"
                if not dst_rel.endswith("/"):
                    dst_rel = f"{dst_rel.rstrip('/')}/"
                shares = list(StorageShare.objects.filter(owner_sub=claims['sub'], key__startswith=src_rel))
                for sh in shares:
                    sh.key = f"{dst_rel}{sh.key[len(src_rel):]}"
                    sh.is_directory = sh.key.endswith("/")
                    sh.save(update_fields=["key", "is_directory"])
            except Exception:
                # Shares are best-effort; do not fail the move for share update issues.
                pass

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

            # Keep shares in sync for this exact key
            try:
                src_rel = source_subkey.rstrip("/")
                dst_rel = destination[len(user_prefix):].rstrip("/")
                StorageShare.objects.filter(owner_sub=claims['sub'], key=src_rel).update(
                    key=dst_rel,
                    is_directory=False,
                )
            except Exception:
                pass
            ActivityLog.objects.create(
                user_sub=claims['sub'],
                action="move",
                key=source,
                success=True,
                extra={
                    "destination": destination_rel,
                    "from": source_rel,
                    "to": destination_rel,
                    "origin_created_at": origin_created_at,
                    "origin_created_by_email": origin_created_by_email,
                    "old_name": old_name,
                    "new_name": item_name,
                    "rename": is_rename,
                }
            )

            # Also log the destination so file metadata works after rename/move.
            try:
                ActivityLog.objects.create(
                    user_sub=claims['sub'],
                    action="move",
                    key=destination,
                    success=True,
                    extra={
                        "source": source_rel,
                        "from": source_rel,
                        "to": destination_rel,
                        "origin_created_at": origin_created_at,
                        "origin_created_by_email": origin_created_by_email,
                        "old_name": old_name,
                        "new_name": item_name,
                        "rename": is_rename,
                    },
                )
            except Exception:
                pass
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

    user_prefix = _user_root_prefix(claims['sub'])
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
    try:
        limit = int(request.GET.get("limit", 50))
    except Exception:
        limit = 50
    try:
        offset = int(request.GET.get("offset", 0))
    except Exception:
        offset = 0

    limit = max(1, min(200, limit))
    offset = max(0, offset)

    action = (request.GET.get("action") or "").strip()

    raw_from = (request.GET.get("from") or request.GET.get("start") or "").strip()
    raw_to = (request.GET.get("to") or request.GET.get("end") or "").strip()

    def _parse_dt(raw: str, *, end_of_day: bool) -> Optional[datetime]:
        if not raw:
            return None
        try:
            # Allow ISO datetimes. Also accept 'Z'.
            normalized = raw.replace("Z", "+00:00")
            if len(normalized) == 10 and normalized[4] == "-" and normalized[7] == "-":
                d = datetime.fromisoformat(normalized).date()
                if end_of_day:
                    dt = datetime(d.year, d.month, d.day, 23, 59, 59, 999999)
                else:
                    dt = datetime(d.year, d.month, d.day, 0, 0, 0)
            else:
                dt = datetime.fromisoformat(normalized)
            if timezone.is_naive(dt):
                return timezone.make_aware(dt, timezone.get_current_timezone())
            return dt
        except Exception:
            return None

    from_dt = _parse_dt(raw_from, end_of_day=False)
    to_dt = _parse_dt(raw_to, end_of_day=True)

    qs = ActivityLog.objects.filter(user_sub=claims['sub'])
    if action:
        qs = qs.filter(action=action)
    if from_dt:
        qs = qs.filter(created_at__gte=from_dt)
    if to_dt:
        qs = qs.filter(created_at__lte=to_dt)

    user_prefix = _user_root_prefix(claims['sub'])

    # Best-effort actor email resolution.
    _record_identity(claims)
    actor_email = (_extract_email_from_claims(claims) or "").strip().lower()
    if not actor_email:
        try:
            ident = UserIdentity.objects.filter(sub=claims['sub']).first()
            if ident and ident.email:
                actor_email = str(ident.email).strip().lower()
        except Exception:
            pass
    if not actor_email:
        actor_email = "anonymous"

    def _mask_key(key: Optional[str]) -> Optional[str]:
        if not key:
            return key
        try:
            if key.startswith(user_prefix):
                rest = key[len(user_prefix):]
                # Display paths rooted at the user's storage root.
                # '/' represents the user's root folder; nested paths are '/<path>'.
                return f"/{rest}" if rest else "/"
        except Exception:
            pass
        return key

    logs = qs.order_by("-created_at")[offset : offset + limit]
    data = [
        {
            "action": l.action,
            "key": _mask_key(l.key),
            "success": l.success,
            "created_at": l.created_at.isoformat(),
            "extra": l.extra,
            "email": actor_email,
        }
        for l in logs
    ]
    return JsonResponse({"logs": data})


def _build_share_payload(share: StorageShare):
    return {
        "share_id": str(share.id),
        "key": share.key,
        "target_sub": share.target_sub,
        "target_email": share.target_email,
        "permission": share.permission,
        "expires_at": share.expires_at.isoformat() if share.expires_at else None,
        "visibility": share.visibility,
        "token": share.token,
        "allowed_emails": share.allowed_emails,
        "is_directory": share.is_directory,
        "owner_sub": share.owner_sub,
    }


def _create_share(owner_sub: str, key: str, permission: str, visibility: str, target_sub: Optional[str], target_email: Optional[str], allowed_emails: list[str], expires_in: Optional[str]):
    if visibility not in ("private", "public", "protected"):
        return None, JsonResponse({"error": "invalid_visibility"}, status=400)

    if permission not in ("read", "read-write"):
        return None, JsonResponse({"error": "invalid_permission"}, status=400)

    # Restrict broad shares to read-only
    if visibility in ("public", "protected") and permission != "read":
        return None, JsonResponse({"error": "permission_not_allowed_for_visibility"}, status=400)

    is_dir = key.endswith("/")
    expires_at = None
    if expires_in:
        try:
            seconds = int(expires_in)
            expires_at = timezone.now() + timedelta(seconds=seconds)
        except ValueError:
            return None, JsonResponse({"error": "invalid_expires"}, status=400)

    if visibility == "public":
        target_sub = None
        target_email = None
        allowed_emails = []
    elif visibility == "protected":
        target_sub = None
        target_email = None
        allowed_emails = allowed_emails or []

    share = StorageShare.objects.create(
        owner_sub=owner_sub,
        target_sub=target_sub,
        target_email=target_email.lower() if target_email else None,
        key=key,
        is_directory=is_dir,
        permission=permission,
        visibility=visibility,
        allowed_emails=allowed_emails,
        expires_at=expires_at,
    )
    return share, None


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def share_with_user(request):
    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    _record_identity(claims)
    raw_key = request.POST.get("key", "") or ""
    is_dir = raw_key.endswith("/")
    sanitized = _sanitize_subpath(raw_key).rstrip("/") if is_dir else _sanitize_subpath(raw_key)
    key = f"{sanitized}/" if is_dir else sanitized
    target_sub = request.POST.get("target_sub")
    target_email = (request.POST.get("target_email") or "").strip().lower()
    if not target_email and target_sub:
        identity = UserIdentity.objects.filter(sub=target_sub).first()
        if identity:
            target_email = identity.email
    permission = request.POST.get("permission", "read")
    expires_in = request.POST.get("expires_in")
    if not key or not (target_email or target_sub):
        return JsonResponse({"error": "missing_params"}, status=400)
    if not target_email:
        return JsonResponse({"error": "target_email_required"}, status=400)

    # Best-effort: resolve a stable target_sub for private shares so recipients can
    # list their shares even when email claims are missing.
    target_sub_resolved: Optional[str] = None
    if target_sub:
        target_sub_resolved = target_sub
    else:
        try:
            identity = UserIdentity.objects.filter(email=target_email).first()
            if identity:
                target_sub_resolved = identity.sub
        except Exception:
            pass
        if not target_sub_resolved:
            target_sub_resolved = _auth0_user_sub_by_email(target_email)

    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    owner_prefix = _user_root_prefix(claims['sub'])
    full_key = f"{owner_prefix}{key}"
    if key.endswith("/"):
        if not _prefix_exists(s3, bucket, full_key):
            # allow sharing empty directories by creating a marker
            try:
                s3.put_object(Bucket=bucket, Key=full_key)
            except ClientError:
                pass
    else:
        if not _key_exists(s3, bucket, full_key):
            return JsonResponse({"error": "not_found"}, status=404)

    share, error = _create_share(
        owner_sub=claims['sub'],
        key=key,
        permission=permission,
        visibility="private",
        target_sub=target_sub_resolved,
        target_email=target_email,
        allowed_emails=[],
        expires_in=expires_in,
    )
    if error:
        return error

    ActivityLog.objects.create(
        user_sub=claims['sub'],
        action="share_create",
        key=key,
        success=True,
        extra={"target_sub": target_sub_resolved or target_sub, "visibility": "private"},
    )
    return JsonResponse(_build_share_payload(share))


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def create_share(request):
    claims = dict(getattr(request, "oauth_token", {}))
    _record_identity(claims)
    raw_key = request.POST.get("key", "") or ""
    is_dir = raw_key.endswith("/")
    sanitized = _sanitize_subpath(raw_key).rstrip("/") if is_dir else _sanitize_subpath(raw_key)
    key = f"{sanitized}/" if is_dir else sanitized
    visibility = request.POST.get("visibility", "private")
    permission = request.POST.get("permission", "read")
    target_sub = request.POST.get("target_sub")
    target_email_raw = request.POST.get("target_email") or ""
    allowed_emails_raw = request.POST.get("allowed_emails") or ""
    expires_in = request.POST.get("expires_in")

    if not key:
        return JsonResponse({"error": "missing_key"}, status=400)

    parsed_emails = _parse_allowed_emails(allowed_emails_raw)
    target_email = target_email_raw.strip().lower()
    target_sub_resolved: Optional[str] = None
    if visibility == "private":
        if not target_email and target_sub:
            identity = UserIdentity.objects.filter(sub=target_sub).first()
            if identity:
                target_email = identity.email
        if not target_email:
            return JsonResponse({"error": "target_email_required"}, status=400)
        # Try to resolve a stable target_sub for private shares.
        # This is important because Auth0 access tokens often omit email claims.
        if target_sub:
            target_sub_resolved = target_sub
        else:
            identity = UserIdentity.objects.filter(email=target_email).first()
            if identity:
                target_sub_resolved = identity.sub
            if not target_sub_resolved:
                # Fallback for when the recipient has never hit our API (no UserIdentity record)
                target_sub_resolved = _auth0_user_sub_by_email(target_email)
    if visibility == "protected" and not parsed_emails:
        return JsonResponse({"error": "allowed_emails_required"}, status=400)

    bucket = settings.S3_BUCKET
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    owner_prefix = _user_root_prefix(claims['sub'])
    full_key = f"{owner_prefix}{key}"
    if key.endswith("/"):
        if not _prefix_exists(s3, bucket, full_key):
            # allow sharing empty directories by creating a marker
            try:
                s3.put_object(Bucket=bucket, Key=full_key)
            except ClientError:
                pass
    else:
        if not _key_exists(s3, bucket, full_key):
            return JsonResponse({"error": "not_found"}, status=404)

    existing = StorageShare.objects.filter(owner_sub=claims['sub'], key=key).first()
    if existing:
        # Update in place to avoid issuing a new token/link
        existing.visibility = visibility
        existing.permission = permission
        if visibility == "private":
            # Only overwrite target_sub if we can resolve one; otherwise keep the old value
            # so existing links keep working even if email claims are missing.
            if target_sub_resolved:
                existing.target_sub = target_sub_resolved
        else:
            existing.target_sub = None
        existing.target_email = target_email or None
        existing.allowed_emails = parsed_emails
        if expires_in:
            try:
                seconds = int(expires_in)
                existing.expires_at = timezone.now() + timedelta(seconds=seconds)
            except Exception:
                existing.expires_at = None
        else:
            existing.expires_at = None
        existing.is_directory = key.endswith("/")
        existing.save()
        share = existing
        created = False
        error = None
    else:
        share, error = _create_share(
            owner_sub=claims['sub'],
            key=key,
            permission=permission,
            visibility=visibility,
            target_sub=target_sub_resolved,
            target_email=target_email,
            allowed_emails=parsed_emails,
            expires_in=expires_in,
        )
        created = True
    if error:
        return error

    payload = _build_share_payload(share)
    payload["access_url"] = request.build_absolute_uri(f"/storage/share/access?token={share.token}")
    ActivityLog.objects.create(
        user_sub=claims['sub'],
        action="share_create" if created else "share_update",
        key=key,
        success=True,
        extra={"visibility": visibility, "target_sub": target_sub, "allowed_emails": parsed_emails},
    )
    return JsonResponse(payload)


@csrf_exempt
@require_http_methods(["GET"])
def access_share(request):
    token_param = request.GET.get("token")
    if not token_param:
        return JsonResponse({"error": "missing_token"}, status=400)

    # Redirect to the frontend share viewer when configured, unless format=json is explicitly requested
    if FRONTEND_SHARE_BASE and request.GET.get("format") != "json":
        target = f"{FRONTEND_SHARE_BASE.rstrip('/')}/share?token={token_param}"
        return HttpResponseRedirect(target)

    share = StorageShare.objects.filter(token=token_param).first()
    if not share:
        return JsonResponse({"error": "not_found"}, status=404)

    if share.expires_at and share.expires_at <= timezone.now():
        # Do not reveal whether a share once existed.
        return JsonResponse({"error": "not_found"}, status=404)

    claims = _optional_claims(request)
    viewer_sub = (claims or {}).get("sub")
    id_claims = _optional_id_token_claims(request)
    id_sub = (id_claims or {}).get("sub")
    # Only trust ID token claims if they belong to the same subject as the API access token.
    if id_claims and viewer_sub and id_sub and viewer_sub != id_sub:
        id_claims = None

    _record_identity(claims)
    if id_claims:
        _record_identity(id_claims)

    fe_claims = _optional_frontend_email(request)
    if fe_claims and viewer_sub and fe_claims.get("sub") != viewer_sub:
        fe_claims = None
    if fe_claims:
        _record_identity(fe_claims)

    viewer_email = (
        _extract_email_from_claims(claims)
        or _extract_email_from_claims(id_claims)
        or _extract_email_from_claims(fe_claims)
    )
    if not viewer_email and viewer_sub:
        identity = UserIdentity.objects.filter(sub=viewer_sub).first()
        if identity and identity.email:
            viewer_email = identity.email.lower()
    if not viewer_email and viewer_sub:
        viewer_email = _auth0_user_email_by_sub(viewer_sub) or viewer_email

    if share.visibility == "private":
        if not claims:
            return JsonResponse({"error": "auth_required"}, status=401)
        # Try to backfill target_sub so we can validate via viewer_sub.
        if not share.target_sub and share.target_email:
            resolved = None
            ident = UserIdentity.objects.filter(email=str(share.target_email).lower()).first()
            if ident and ident.sub:
                resolved = ident.sub
            if not resolved:
                resolved = _auth0_user_sub_by_email(str(share.target_email).lower())
            if resolved:
                try:
                    share.target_sub = resolved
                    share.save(update_fields=["target_sub"])
                except Exception:
                    pass

        target_email = (share.target_email or "").lower()
        target_sub = share.target_sub
        allowed_emails = [e.lower() for e in (share.allowed_emails or [])]
        allowed = False
        if target_email and viewer_email:
            allowed = viewer_email == target_email
        if not allowed and target_sub and viewer_sub:
            allowed = viewer_sub == target_sub
        if not allowed and viewer_email and viewer_email in allowed_emails:
            allowed = True
        if not allowed:
            try:
                ActivityLog.objects.create(
                    user_sub=share.owner_sub,
                    action="share_access_denied",
                    key=share.key,
                    success=False,
                    extra={"reason": "access_denied"},
                )
            except Exception:
                pass
            return JsonResponse({"error": "access_denied"}, status=403)

    if share.visibility == "protected":
        if not claims:
            return JsonResponse({"error": "auth_required"}, status=401)
        if not viewer_email:
            try:
                ActivityLog.objects.create(
                    user_sub=share.owner_sub,
                    action="share_access_denied",
                    key=share.key,
                    success=False,
                    extra={"reason": "access_denied"},
                )
            except Exception:
                pass
            return JsonResponse({"error": "access_denied"}, status=403)
        allowed = [e.lower() for e in (share.allowed_emails or [])]
        if viewer_email.lower() not in allowed:
            try:
                ActivityLog.objects.create(
                    user_sub=share.owner_sub,
                    action="share_access_denied",
                    key=share.key,
                    success=False,
                    extra={"reason": "access_denied"},
                )
            except Exception:
                pass
            return JsonResponse({"error": "access_denied"}, status=403)

    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)

    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    full_key = f"{_user_root_prefix(share.owner_sub)}{share.key}"

    payload = {
        "key": share.key,
        "visibility": share.visibility,
        "is_directory": share.is_directory,
        "expires_at": share.expires_at.isoformat() if share.expires_at else None,
        "owner_sub": share.owner_sub,
        "allowed": True,
    }

    if share.is_directory or full_key.endswith("/"):
        # Directory sharing: browse or download as zip
        if request.GET.get("zip") == "1":
            folder_name = (share.key.rstrip("/").split("/")[-1]) or "folder"
            zip_bytes = _zip_prefix_to_bytes(s3, bucket, full_key)
            ActivityLog.objects.create(
                user_sub=share.owner_sub,
                action="share_download",
                key=share.key,
                success=True,
                extra={"kind": "zip"},
            )
            response = HttpResponse(zip_bytes, content_type='application/zip')
            response['Content-Disposition'] = f'attachment; filename="{folder_name}.zip"'
            response['Content-Length'] = str(len(zip_bytes))
            return response

        rel_path = _sanitize_subpath(request.GET.get("path", "")).rstrip("/")
        browse_prefix = f"{full_key}{rel_path + '/' if rel_path else ''}"
        try:
            resp = s3.list_objects_v2(Bucket=bucket, Prefix=browse_prefix, Delimiter="/")
        except ClientError as e:
            return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)

        directories = []
        for p in resp.get("CommonPrefixes", []):
            prefix = p.get("Prefix", "")
            name = prefix[len(browse_prefix):].rstrip("/")
            if name:
                directories.append({"name": name})

        files = []
        for obj in resp.get("Contents", []):
            key = obj.get("Key", "")
            if key.endswith("/"):
                continue
            name = key[len(browse_prefix):]
            if "/" in name:
                continue
            presigned = s3.generate_presigned_url(
                ClientMethod="get_object",
                Params={
                    "Bucket": bucket,
                    "Key": key,
                    "ResponseContentDisposition": f"attachment; filename=\"{name}\"",
                },
                ExpiresIn=int(request.GET.get("expires", 300)),
            )
            files.append({
                "name": name,
                "size": obj.get("Size"),
                "last_modified": obj.get("LastModified").isoformat() if obj.get("LastModified") else None,
                "url": presigned,
            })

        payload.update({
            "path": rel_path,
            "directories": directories,
            "files": files,
            "zip_url": request.build_absolute_uri(f"/storage/share/access?token={token_param}&zip=1&format=json") if (directories or files) else None,
        })
        try:
            ActivityLog.objects.create(
                user_sub=share.owner_sub,
                action="share_access_success",
                key=share.key,
                success=True,
                extra={"kind": "directory", "path": rel_path or ""},
            )
        except Exception:
            pass
        return JsonResponse(payload)

    if not _key_exists(s3, bucket, full_key):
        payload.update({"allowed": False, "reason": "not_found"})
        return JsonResponse(payload, status=404)

    try:
        include_url = request.GET.get("presign", "1") != "0"
        url = None
        if include_url:
            download_name = share.key.split("/")[-1] or "file"
            url = s3.generate_presigned_url(
                ClientMethod="get_object",
                Params={
                    "Bucket": bucket,
                    "Key": full_key,
                    "ResponseContentDisposition": f"attachment; filename=\"{download_name}\"",
                },
                ExpiresIn=int(request.GET.get("expires", 300)),
            )
        try:
            ActivityLog.objects.create(
                user_sub=share.owner_sub,
                action="share_access_success",
                key=share.key,
                success=True,
                extra={"kind": "file"},
            )
        except Exception:
            pass
        payload.update({"url": url} if url else {})
        return JsonResponse(payload)
    except ClientError as e:
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@csrf_exempt
@require_http_methods(["POST"])
def log_share_download(request):
    """Log a download attempt for a share link.

    The actual bytes are downloaded from S3 via a presigned URL, so the backend
    cannot observe the real download. This logs the user's intent (button click)
    after applying the same share authorization rules.
    """
    token_param = request.GET.get("token")
    if not token_param:
        return JsonResponse({"error": "missing_token"}, status=400)

    share = StorageShare.objects.filter(token=token_param).first()
    if not share:
        return JsonResponse({"error": "not_found"}, status=404)

    if share.expires_at and share.expires_at <= timezone.now():
        return JsonResponse({"error": "not_found"}, status=404)

    # Reuse the same identity extraction used in access_share
    claims = _optional_claims(request)
    viewer_sub = (claims or {}).get("sub")
    id_claims = _optional_id_token_claims(request)
    id_sub = (id_claims or {}).get("sub")
    if id_claims and viewer_sub and id_sub and viewer_sub != id_sub:
        id_claims = None
    _record_identity(claims)
    if id_claims:
        _record_identity(id_claims)
    fe_claims = _optional_frontend_email(request)
    if fe_claims and viewer_sub and fe_claims.get("sub") != viewer_sub:
        fe_claims = None
    if fe_claims:
        _record_identity(fe_claims)

    viewer_email = (
        _extract_email_from_claims(claims)
        or _extract_email_from_claims(id_claims)
        or _extract_email_from_claims(fe_claims)
    )
    if not viewer_email and viewer_sub:
        identity = UserIdentity.objects.filter(sub=viewer_sub).first()
        if identity and identity.email:
            viewer_email = identity.email.lower()
    if not viewer_email and viewer_sub:
        viewer_email = _auth0_user_email_by_sub(viewer_sub) or viewer_email

    # Authorization (non-informative errors)
    if share.visibility in ("private", "protected") and not claims:
        try:
            ActivityLog.objects.create(
                user_sub=share.owner_sub,
                action="share_download_denied",
                key=share.key,
                success=False,
                extra={"reason": "auth_required"},
            )
        except Exception:
            pass
        return JsonResponse({"error": "auth_required"}, status=401)

    if share.visibility == "private":
        if not share.target_sub and share.target_email:
            resolved = None
            ident = UserIdentity.objects.filter(email=str(share.target_email).lower()).first()
            if ident and ident.sub:
                resolved = ident.sub
            if not resolved:
                resolved = _auth0_user_sub_by_email(str(share.target_email).lower())
            if resolved:
                try:
                    share.target_sub = resolved
                    share.save(update_fields=["target_sub"])
                except Exception:
                    pass

        target_email = (share.target_email or "").lower()
        target_sub = share.target_sub
        allowed_emails = [e.lower() for e in (share.allowed_emails or [])]
        allowed = False
        if target_email and viewer_email:
            allowed = viewer_email == target_email
        if not allowed and target_sub and viewer_sub:
            allowed = viewer_sub == target_sub
        if not allowed and viewer_email and viewer_email in allowed_emails:
            allowed = True
        if not allowed:
            try:
                ActivityLog.objects.create(
                    user_sub=share.owner_sub,
                    action="share_download_denied",
                    key=share.key,
                    success=False,
                    extra={"reason": "access_denied"},
                )
            except Exception:
                pass
            return JsonResponse({"error": "access_denied"}, status=403)

    if share.visibility == "protected":
        if not viewer_email:
            try:
                ActivityLog.objects.create(
                    user_sub=share.owner_sub,
                    action="share_download_denied",
                    key=share.key,
                    success=False,
                    extra={"reason": "access_denied"},
                )
            except Exception:
                pass
            return JsonResponse({"error": "access_denied"}, status=403)
        allowed = [e.lower() for e in (share.allowed_emails or [])]
        if viewer_email.lower() not in allowed:
            try:
                ActivityLog.objects.create(
                    user_sub=share.owner_sub,
                    action="share_download_denied",
                    key=share.key,
                    success=False,
                    extra={"reason": "access_denied"},
                )
            except Exception:
                pass
            return JsonResponse({"error": "access_denied"}, status=403)

    kind = "zip" if request.GET.get("zip") == "1" else "file"
    try:
        ActivityLog.objects.create(
            user_sub=share.owner_sub,
            action="share_download",
            key=share.key,
            success=True,
            extra={"kind": kind},
        )
    except Exception:
        pass

    return HttpResponse(status=204)


@require_auth(None)
@require_http_methods(["GET"])
def list_owned_shares(request):
    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    _record_identity(claims)

    prefix = _sanitize_subpath(request.GET.get("prefix", "")).rstrip("/")
    qs = StorageShare.objects.filter(owner_sub=claims['sub'])
    if prefix:
        qs = qs.filter(key__startswith=f"{prefix}/" if not prefix.endswith("/") else prefix)

    now = timezone.now()
    shares = qs.filter(models.Q(expires_at__isnull=True) | models.Q(expires_at__gt=now))
    data = []
    for s in shares:
        access_url = request.build_absolute_uri(f"/storage/share/access?token={s.token}")
        data.append({
            "share_id": str(s.id),
            "token": s.token,
            "key": s.key,
            "is_directory": s.is_directory,
            "visibility": s.visibility,
            "permission": s.permission,
            "target_email": s.target_email,
            "allowed_emails": s.allowed_emails,
            "expires_at": s.expires_at.isoformat() if s.expires_at else None,
            "access_url": access_url,
        })
    return JsonResponse({"shares": data})


@require_auth(None)
@require_http_methods(["GET"])
def list_shared_with_me(request):
    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    _record_identity(claims)

    viewer_sub = claims.get('sub')
    id_claims = _optional_id_token_claims(request)
    id_sub = (id_claims or {}).get("sub")
    if id_claims and viewer_sub and id_sub and viewer_sub != id_sub:
        id_claims = None
    if id_claims:
        _record_identity(id_claims)

    fe_claims = _optional_frontend_email(request)
    if fe_claims and viewer_sub and fe_claims.get("sub") != viewer_sub:
        fe_claims = None
    if fe_claims:
        _record_identity(fe_claims)

    viewer_email = (
        _extract_email_from_claims(claims)
        or _extract_email_from_claims(id_claims)
        or _extract_email_from_claims(fe_claims)
    )
    if not viewer_email and viewer_sub:
        try:
            identity = UserIdentity.objects.filter(sub=viewer_sub).first()
            if identity and identity.email:
                viewer_email = str(identity.email).lower()
        except Exception:
            pass
    if not viewer_email and viewer_sub:
        viewer_email = _auth0_user_email_by_sub(viewer_sub) or viewer_email

    viewer_email = str(viewer_email).lower() if viewer_email else None
    now = timezone.now()
    qs = StorageShare.objects.filter(
        models.Q(visibility="private") | models.Q(visibility="protected")
    ).filter(models.Q(expires_at__isnull=True) | models.Q(expires_at__gt=now))

    allowed = []
    for s in qs.order_by("-created_at"):
        if s.visibility == "private":
            if viewer_sub and s.target_sub and s.target_sub == viewer_sub:
                allowed.append(s)
                continue
            if viewer_email and s.target_email and str(s.target_email).lower() == viewer_email:
                allowed.append(s)
                continue
        elif s.visibility == "protected":
            if viewer_email:
                emails = s.allowed_emails or []
                try:
                    emails_l = [str(e).strip().lower() for e in emails]
                except Exception:
                    emails_l = []
                if viewer_email in emails_l:
                    allowed.append(s)
                    continue

    owner_email_cache: dict[str, Optional[str]] = {}

    def _owner_email(owner_sub: str) -> Optional[str]:
        if not owner_sub:
            return None
        cached = owner_email_cache.get(owner_sub)
        if cached is not None:
            return cached
        email = None
        try:
            ident = UserIdentity.objects.filter(sub=owner_sub).first()
            if ident and ident.email:
                email = str(ident.email).strip().lower()
        except Exception:
            email = None
        if not email:
            email = _auth0_user_email_by_sub(owner_sub)
        email = str(email).strip().lower() if email else None
        owner_email_cache[owner_sub] = email
        return email

    data = [
        {
            "share_id": str(s.id),
            "owner_sub": s.owner_sub,
            "owner_email": _owner_email(s.owner_sub),
            "key": s.key,
            "is_directory": s.is_directory,
            "permission": s.permission,
            "expires_at": s.expires_at.isoformat() if s.expires_at else None,
            "target_email": s.target_email,
            "visibility": s.visibility,
        }
        for s in allowed
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
    _record_identity(claims)

    viewer_sub = claims.get('sub')
    id_claims = _optional_id_token_claims(request)
    id_sub = (id_claims or {}).get("sub")
    if id_claims and viewer_sub and id_sub and viewer_sub != id_sub:
        id_claims = None
    if id_claims:
        _record_identity(id_claims)

    fe_claims = _optional_frontend_email(request)
    if fe_claims and viewer_sub and fe_claims.get("sub") != viewer_sub:
        fe_claims = None
    if fe_claims:
        _record_identity(fe_claims)

    viewer_email = (
        _extract_email_from_claims(claims)
        or _extract_email_from_claims(id_claims)
        or _extract_email_from_claims(fe_claims)
    )
    if not viewer_email and viewer_sub:
        try:
            identity = UserIdentity.objects.filter(sub=viewer_sub).first()
            if identity and identity.email:
                viewer_email = str(identity.email).lower()
        except Exception:
            pass
    if not viewer_email and viewer_sub:
        viewer_email = _auth0_user_email_by_sub(viewer_sub) or viewer_email

    viewer_email = str(viewer_email).lower() if viewer_email else None
    share_id = request.GET.get("share_id")
    if not share_id:
        return JsonResponse({"error": "missing_share_id"}, status=400)
    share = StorageShare.objects.filter(id=share_id).first()
    if not share:
        return JsonResponse({"error": "not_found"}, status=404)
    if share.visibility not in ("private", "protected"):
        return JsonResponse({"error": "not_found"}, status=404)

    # Authorization checks
    authorized = False
    if share.visibility == "private":
        if viewer_sub and share.target_sub and share.target_sub == viewer_sub:
            authorized = True
        if not authorized and viewer_email and share.target_email and str(share.target_email).lower() == viewer_email:
            authorized = True
    elif share.visibility == "protected":
        if viewer_email:
            try:
                emails = [str(e).strip().lower() for e in (share.allowed_emails or [])]
            except Exception:
                emails = []
            if viewer_email in emails:
                authorized = True

    if not authorized:
        return JsonResponse({"error": "not_found"}, status=404)
    if not share:
        return JsonResponse({"error": "not_found"}, status=404)
    if share.expires_at and share.expires_at <= timezone.now():
        return JsonResponse({"error": "share_expired"}, status=403)

    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    owner_prefix = _user_root_prefix(share.owner_sub)
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
    user_prefix = _user_root_prefix(claims['sub'])
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
        FileVersion.objects.create(
            owner_sub=claims['sub'],
            key=logical,
            version=next_version,
            object_key=version_key,
            size=head.get("ContentLength"),
            etag=head.get("ETag"),
        )
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


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def chunked_initiate(request):
    """Start/resume a chunked upload.

        Client sends the whole-file checksum first. Chunk checksums may be sent
        up-front (for explicit missing list) or omitted (client can discover
        present chunks opportunistically as it computes chunk checksums).
    Server responds with which chunks already exist under:
      <sub>/chunks/<file_checksum>/<chunk_checksum>
    """
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    sub = claims.get("sub")
    if not sub:
        return JsonResponse({"error": "unauthorized"}, status=401)

    filename = request.POST.get("filename")
    subdir = _sanitize_subpath(request.POST.get("path", "")).rstrip("/")
    file_checksum = (request.POST.get("file_checksum") or "").strip().lower()
    chunk_size = request.POST.get("chunk_size")
    total_size = request.POST.get("total_size")
    chunks_json = request.POST.get("chunk_checksums")

    if not filename:
        return JsonResponse({"error": "missing_filename"}, status=400)
    if not _is_sha256_hex(file_checksum):
        return JsonResponse({"error": "invalid_file_checksum"}, status=400)

    normalized: list[str] = []
    has_chunk_list = False
    if chunks_json:
        try:
            chunk_checksums = json.loads(chunks_json)
        except Exception:
            return JsonResponse({"error": "invalid_chunk_checksums"}, status=400)
        if not isinstance(chunk_checksums, list) or not chunk_checksums:
            return JsonResponse({"error": "invalid_chunk_checksums"}, status=400)

        for c in chunk_checksums:
            s = str(c or "").strip().lower()
            if not _is_sha256_hex(s):
                return JsonResponse({"error": "invalid_chunk_checksum"}, status=400)
            normalized.append(s)
        has_chunk_list = True

    # Enforce 2GB limit unless explicitly changed later.
    if total_size:
        try:
            if int(total_size) > 2 * 1024 * 1024 * 1024:
                return JsonResponse({"error": "file_too_large", "limit": 2 * 1024 * 1024 * 1024}, status=413)
        except ValueError:
            pass

    if chunk_size:
        try:
            cs = int(chunk_size)
            if cs != 1024 * 1024:
                return JsonResponse({"error": "invalid_chunk_size", "expected": 1024 * 1024}, status=400)
        except ValueError:
            return JsonResponse({"error": "invalid_chunk_size", "expected": 1024 * 1024}, status=400)

    chunks_prefix = f"{_user_chunks_prefix(sub)}{file_checksum}/"
    manifest_key = f"{chunks_prefix}manifest.json"

    # Persist/keep a manifest so the UI can show unfinished uploads after refresh.
    started_at = None
    try:
        existing = s3.get_object(Bucket=bucket, Key=manifest_key)
        body = existing.get("Body")
        raw = body.read().decode("utf-8") if body else ""
        data = json.loads(raw) if raw else {}
        started_at = data.get("started_at")
    except Exception:
        started_at = None

    if not started_at:
        started_at = timezone.now().isoformat()

    try:
        manifest = {
            "file_checksum": file_checksum,
            "filename": filename,
            "path": subdir,
            "chunk_size": 1024 * 1024,
            "total_size": int(total_size) if str(total_size or "").strip().isdigit() else None,
            "chunk_checksums": normalized if has_chunk_list else [],
            "started_at": started_at,
            "updated_at": timezone.now().isoformat(),
        }
        s3.put_object(
            Bucket=bucket,
            Key=manifest_key,
            Body=json.dumps(manifest).encode("utf-8"),
            ContentType="application/json",
        )
    except Exception:
        # Manifest is best-effort; uploads can still proceed without it.
        pass
    present: set[str] = set()
    continuation = None
    try:
        while True:
            kwargs = {"Bucket": bucket, "Prefix": chunks_prefix}
            if continuation:
                kwargs["ContinuationToken"] = continuation
            resp = s3.list_objects_v2(**kwargs)
            for obj in resp.get("Contents", []) or []:
                key = obj.get("Key") or ""
                # key ends with <chunk_checksum>
                leaf = key.rsplit("/", 1)[-1]
                leaf = str(leaf).strip().lower()
                if _is_sha256_hex(leaf):
                    present.add(leaf)
            if resp.get("IsTruncated"):
                continuation = resp.get("NextContinuationToken")
            else:
                break
    except ClientError:
        # If listing fails, treat as empty and let client proceed.
        present = set()

    missing = [c for c in normalized if c not in present] if has_chunk_list else []

    logical_path = f"{subdir + '/' if subdir else ''}{filename}"
    return JsonResponse({
        "file_checksum": file_checksum,
        "chunk_size": 1024 * 1024,
        "filename": filename,
        "path": subdir,
        "logical_path": logical_path,
        "present": list(present.intersection(set(normalized))) if has_chunk_list else list(present),
        "missing": missing,
    })


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def chunked_upload_chunk(request):
    """Upload a single 1MB chunk to <sub>/chunks/<file>/<chunk>.

    Server verifies sha256(chunk_bytes) == chunk_checksum, then stores it.
    """
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    sub = claims.get("sub")
    if not sub:
        return JsonResponse({"error": "unauthorized"}, status=401)

    file_checksum = (request.POST.get("file_checksum") or "").strip().lower()
    chunk_checksum = (request.POST.get("chunk_checksum") or "").strip().lower()
    if not _is_sha256_hex(file_checksum) or not _is_sha256_hex(chunk_checksum):
        return JsonResponse({"error": "invalid_checksum"}, status=400)

    body_file = request.FILES.get("chunk")
    if body_file is not None:
        chunk_bytes = body_file.read()
    else:
        chunk_bytes = request.body

    if not chunk_bytes:
        return JsonResponse({"error": "missing_chunk"}, status=400)
    if len(chunk_bytes) > 1024 * 1024:
        return JsonResponse({"error": "chunk_too_large", "limit": 1024 * 1024}, status=413)

    computed = hashlib.sha256(chunk_bytes).hexdigest()
    if computed != chunk_checksum:
        return JsonResponse({
            "error": "chunk_checksum_mismatch",
            "expected": chunk_checksum,
            "got": computed,
        }, status=400)

    key = f"{_user_chunks_prefix(sub)}{file_checksum}/{chunk_checksum}"
    try:
        # Idempotent: if already exists, we still return confirmed.
        try:
            s3.head_object(Bucket=bucket, Key=key)
            return JsonResponse({"ok": True, "confirmed": True, "chunk_checksum": chunk_checksum})
        except ClientError:
            pass

        s3.put_object(Bucket=bucket, Key=key, Body=chunk_bytes, ContentType="application/octet-stream")
        return JsonResponse({"ok": True, "confirmed": True, "chunk_checksum": chunk_checksum})
    except ClientError as e:
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@require_auth(None)
@csrf_exempt
@require_http_methods(["POST"])
def chunked_complete(request):
    """Finalize a chunked upload.

    Reads staged chunks from <sub>/chunks/<file>/<chunk>, assembles into the final
    object under <sub>/root/<path>/<filename>.

    Note: S3 multipart upload enforces a 5MB minimum part size, so we aggregate
    1MB chunks into >=5MB parts when uploading the final object.
    """
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    sub = claims.get("sub")
    if not sub:
        return JsonResponse({"error": "unauthorized"}, status=401)

    filename = request.POST.get("filename")
    subdir = _sanitize_subpath(request.POST.get("path", "")).rstrip("/")
    file_checksum = (request.POST.get("file_checksum") or "").strip().lower()
    chunks_json = request.POST.get("chunk_checksums")
    total_size = request.POST.get("total_size")

    if not filename:
        return JsonResponse({"error": "missing_filename"}, status=400)
    if not _is_sha256_hex(file_checksum):
        return JsonResponse({"error": "invalid_file_checksum"}, status=400)
    if not chunks_json:
        return JsonResponse({"error": "missing_chunk_checksums"}, status=400)

    try:
        chunk_checksums = json.loads(chunks_json)
    except Exception:
        return JsonResponse({"error": "invalid_chunk_checksums"}, status=400)
    if not isinstance(chunk_checksums, list) or not chunk_checksums:
        return JsonResponse({"error": "invalid_chunk_checksums"}, status=400)

    normalized = []
    for c in chunk_checksums:
        s = str(c or "").strip().lower()
        if not _is_sha256_hex(s):
            return JsonResponse({"error": "invalid_chunk_checksum"}, status=400)
        normalized.append(s)

    # Enforce 2GB limit unless explicitly changed later.
    if total_size:
        try:
            if int(total_size) > 2 * 1024 * 1024 * 1024:
                return JsonResponse({"error": "file_too_large", "limit": 2 * 1024 * 1024 * 1024}, status=413)
        except ValueError:
            pass

    user_prefix = _user_root_prefix(sub)
    key = f"{user_prefix}{subdir + '/' if subdir else ''}{filename}"

    # Ensure all chunks exist
    missing = []
    for chk in normalized:
        chunk_key = f"{_user_chunks_prefix(sub)}{file_checksum}/{chk}"
        try:
            s3.head_object(Bucket=bucket, Key=chunk_key)
        except ClientError:
            missing.append(chk)
    if missing:
        return JsonResponse({"error": "missing_chunks", "missing": missing}, status=409)

    # Version backup if exists (same behavior as normal uploads)
    try:
        head = s3.head_object(Bucket=bucket, Key=key)
        logical = key[len(user_prefix):]
        latest = FileVersion.objects.filter(owner_sub=sub, key=logical).order_by("-version").first()
        next_version = (latest.version + 1) if latest else 1
        name, ext = os.path.splitext(key)
        version_key = f"{name}.v{next_version}{ext}"
        s3.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": key}, Key=version_key)
        FileVersion.objects.create(
            owner_sub=sub,
            key=logical,
            version=next_version,
            object_key=version_key,
            size=head.get("ContentLength"),
            etag=head.get("ETag"),
        )
    except ClientError:
        pass

    # Assemble and upload using S3 multipart, but aggregate 1MB chunks into >=5MB parts.
    upload_id = None
    try:
        create = s3.create_multipart_upload(Bucket=bucket, Key=key)
        upload_id = create.get("UploadId")
        if not upload_id:
            return JsonResponse({"error": "multipart_create_failed"}, status=502)

        parts = []
        part_no = 1
        min_part = 5 * 1024 * 1024
        buffer = bytearray()
        assembled_hasher = hashlib.sha256()

        for idx, chk in enumerate(normalized):
            chunk_key = f"{_user_chunks_prefix(sub)}{file_checksum}/{chk}"
            obj = s3.get_object(Bucket=bucket, Key=chunk_key)
            data = obj["Body"].read()
            assembled_hasher.update(data)
            buffer.extend(data)

            is_last_chunk = (idx == len(normalized) - 1)
            if (len(buffer) >= min_part) or is_last_chunk:
                resp = s3.upload_part(
                    Bucket=bucket,
                    Key=key,
                    PartNumber=part_no,
                    UploadId=upload_id,
                    Body=bytes(buffer),
                )
                parts.append({"PartNumber": part_no, "ETag": resp.get("ETag")})
                part_no += 1
                buffer = bytearray()

        resp = s3.complete_multipart_upload(
            Bucket=bucket,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={"Parts": parts},
        )

        assembled_checksum = assembled_hasher.hexdigest()
        if assembled_checksum != file_checksum:
            try:
                s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
            except Exception:
                pass
            return JsonResponse({
                "error": "file_checksum_mismatch",
                "expected": file_checksum,
                "got": assembled_checksum,
            }, status=400)

        ActivityLog.objects.create(
            user_sub=sub,
            action="upload_chunked",
            key=key,
            success=True,
            extra={
                "file_checksum": file_checksum,
                "chunks": len(normalized),
                "uploader_email": (_extract_email_from_claims(claims) or "").strip().lower() or None,
            },
        )

        # Cleanup staged chunks (and manifest) so "unfinished uploads" doesn't linger.
        try:
            staging_prefix = f"{_user_chunks_prefix(sub)}{file_checksum}/"
            _delete_s3_prefix(s3, bucket, staging_prefix)
        except Exception:
            pass

        return JsonResponse({"ok": True, "key": key, "etag": resp.get("ETag")})
    except ClientError as e:
        try:
            if upload_id:
                s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
        except Exception:
            pass
        ActivityLog.objects.create(
            user_sub=sub,
            action="upload_chunked",
            key=key,
            success=False,
            extra={"error": str(e), "file_checksum": file_checksum},
        )
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

    raw_key = request.GET.get("key") or request.POST.get("key") or ""
    is_dir_request = raw_key.endswith("/")
    subkey = _sanitize_subpath(raw_key)
    if is_dir_request and subkey:
        subkey = f"{subkey}/"
    if not subkey:
        return JsonResponse({"error": "missing_key"}, status=400)

    key = f"{user_prefix}{subkey}"

    try:
        if key.endswith("/"):
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
            ActivityLog.objects.create(
                user_sub=claims['sub'], action="delete_prefix", key=key, success=True, extra={"deleted": deleted}
            )

            # Delete any shares for this folder and anything under it
            try:
                StorageShare.objects.filter(owner_sub=claims['sub'], key__startswith=subkey).delete()
            except Exception:
                pass
            return JsonResponse({"deleted_prefix": key, "deleted_count": deleted})
        else:
            s3.delete_object(Bucket=bucket, Key=key)
            ActivityLog.objects.create(user_sub=claims['sub'], action="delete", key=key, success=True)

            # Delete any share for this exact file key
            try:
                StorageShare.objects.filter(owner_sub=claims['sub'], key=subkey).delete()
            except Exception:
                pass
            return JsonResponse({"deleted": True, "key": key})
    except ClientError as e:
        ActivityLog.objects.create(user_sub=claims['sub'], action="delete", key=key, success=False, extra={"error": str(e)})
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)


@require_auth(None)
@csrf_exempt
@require_http_methods(["GET"])
def chunked_unfinished(request):
    """List chunked upload manifests for the current user."""
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    sub = claims.get("sub")
    if not sub:
        return JsonResponse({"error": "unauthorized"}, status=401)

    base_prefix = _user_chunks_prefix(sub)

    # Discover per-upload prefixes without scanning every chunk object.
    upload_prefixes = []
    continuation = None
    try:
        while True:
            kwargs = {"Bucket": bucket, "Prefix": base_prefix, "Delimiter": "/"}
            if continuation:
                kwargs["ContinuationToken"] = continuation
            resp = s3.list_objects_v2(**kwargs)
            for cp in resp.get("CommonPrefixes", []) or []:
                pfx = cp.get("Prefix") or ""
                if pfx and pfx != base_prefix:
                    upload_prefixes.append(pfx)
            if resp.get("IsTruncated"):
                continuation = resp.get("NextContinuationToken")
            else:
                break
    except ClientError as e:
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)

    sessions = []
    for upload_prefix in upload_prefixes:
        manifest_key = f"{upload_prefix}manifest.json"
        try:
            obj = s3.get_object(Bucket=bucket, Key=manifest_key)
            raw = obj["Body"].read().decode("utf-8")
            manifest = json.loads(raw)
        except Exception:
            continue

        file_checksum = str(manifest.get("file_checksum") or "").strip().lower()
        if not _is_sha256_hex(file_checksum):
            continue

        chunk_checksums = manifest.get("chunk_checksums")
        if not isinstance(chunk_checksums, list) or not chunk_checksums:
            continue
        chunk_checksums = [str(x or "").strip().lower() for x in chunk_checksums]

        # List present chunks for this file_checksum.
        staging_prefix = f"{base_prefix}{file_checksum}/"
        present = set()
        cont2 = None
        try:
            while True:
                kwargs2 = {"Bucket": bucket, "Prefix": staging_prefix}
                if cont2:
                    kwargs2["ContinuationToken"] = cont2
                resp2 = s3.list_objects_v2(**kwargs2)
                for o in resp2.get("Contents", []) or []:
                    k2 = o.get("Key") or ""
                    leaf = k2.rsplit("/", 1)[-1].strip().lower()
                    if _is_sha256_hex(leaf):
                        present.add(leaf)
                if resp2.get("IsTruncated"):
                    cont2 = resp2.get("NextContinuationToken")
                else:
                    break
        except ClientError:
            present = set()

        # Compute uploaded_bytes based on present checksums and sizes (no HEAD per chunk).
        chunk_size = int(manifest.get("chunk_size") or 1024 * 1024)
        total_size = manifest.get("total_size")
        try:
            total_size_int = int(total_size) if total_size is not None else None
        except Exception:
            total_size_int = None

        uploaded_bytes = 0
        for idx, chk in enumerate(chunk_checksums):
            if chk not in present:
                continue
            if total_size_int is None:
                uploaded_bytes += chunk_size
            else:
                is_last = idx == len(chunk_checksums) - 1
                if not is_last:
                    uploaded_bytes += chunk_size
                else:
                    last_size = total_size_int - (chunk_size * (len(chunk_checksums) - 1))
                    uploaded_bytes += max(0, int(last_size))

        sessions.append({
            "file_checksum": file_checksum,
            "filename": manifest.get("filename"),
            "path": manifest.get("path") or "",
            "chunk_size": chunk_size,
            "total_size": total_size_int,
            "chunks_total": len(chunk_checksums),
            "chunks_present": len([c for c in chunk_checksums if c in present]),
            "uploaded_bytes": uploaded_bytes,
            "started_at": manifest.get("started_at"),
            "updated_at": manifest.get("updated_at"),
        })

    return JsonResponse({"uploads": sessions})


@require_auth(None)
@csrf_exempt
@require_http_methods(["DELETE"])
def chunked_abort(request):
    """Abort a chunked upload by deleting its staged chunks."""
    bucket = settings.S3_BUCKET
    if not bucket:
        return JsonResponse({"error": "s3_not_configured"}, status=500)
    try:
        s3 = _get_s3_client()
    except Exception as e:
        return JsonResponse({"error": "s3_client_error", "details": str(e)}, status=500)

    token = getattr(request, "oauth_token", None)
    claims = dict(token)
    sub = claims.get("sub")
    if not sub:
        return JsonResponse({"error": "unauthorized"}, status=401)

    file_checksum = (request.GET.get("file_checksum") or "").strip().lower()
    if not _is_sha256_hex(file_checksum):
        return JsonResponse({"error": "invalid_file_checksum"}, status=400)

    prefix = f"{_user_chunks_prefix(sub)}{file_checksum}/"
    try:
        deleted = _delete_s3_prefix(s3, bucket, prefix)
        ActivityLog.objects.create(
            user_sub=sub,
            action="upload_chunked_abort",
            key=prefix,
            success=True,
            extra={"file_checksum": file_checksum, "deleted": deleted},
        )
        return JsonResponse({"ok": True, "deleted": deleted})
    except ClientError as e:
        ActivityLog.objects.create(
            user_sub=sub,
            action="upload_chunked_abort",
            key=prefix,
            success=False,
            extra={"file_checksum": file_checksum, "error": str(e)},
        )
        return JsonResponse({"error": "s3_error", "details": str(e)}, status=502)