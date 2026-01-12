from authlib.integrations.django_oauth2 import ResourceProtector
from django.http import JsonResponse
from config import validator
from config import settings
from spc_auth.auth import require_auth

def public(request):
    """No access token required to access this route
    """
    response = "Hello from a public endpoint! You don't need to be authenticated to see this."
    return JsonResponse(dict(message=response))

@require_auth(None)
def private(request):
    """A valid access token is required to access this route
    """
    response = "Hello from a private endpoint! You need to be authenticated to see this."
    return JsonResponse(dict(message=response))

@require_auth("read:messages")
def private_scoped(request):
    """A valid access token and an appropriate scope are required to access this route
    """
    response = "Hello from a private endpoint! You need to be authenticated and have a scope of read:messages to see this."
    return JsonResponse(dict(message=response))

@require_auth(None)
def jwt_info(request):
    """Return the authenticated user's JWT token information.

    Requires a valid Bearer token. Returns all claims and header.
    """
    token = getattr(request, "oauth_token", None)
    if token is None:
        # Should not happen due to decorator, but be safe.
        return JsonResponse({"error": "no_token"}, status=401)

    # token is a dict-like JWTClaims; header is a dict.
    claims = dict(token)
    header = dict(getattr(token, "header", {}) or {})
    return JsonResponse({"jwt": {"claims": claims, "header": header}})