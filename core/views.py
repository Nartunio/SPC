import os
from functools import wraps

from django.conf import settings
from django.http import HttpResponse, JsonResponse, HttpResponseRedirect
from django.shortcuts import render, redirect
from django.urls import reverse

from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from authlib.integrations.django_client import OAuth
from jose import jwt, JWTError

# 1) Inicjalizacja klienta OIDC (Authlib)
oauth = OAuth()
auth0 = oauth.register(
    name="auth0",
    client_id=settings.AUTH0_CLIENT_ID,
    client_secret=settings.AUTH0_CLIENT_SECRET,
    server_metadata_url=f"https://{settings.AUTH0_DOMAIN}/.well-known/openid-configuration",
    client_kwargs={"scope": "openid profile email"},
)

# 2) Widok główny
@api_view(['GET'])
def index(request):
    user = request.session.get("user")
    if user:
        return Response({
            "username": user,
            "status": 'logged_in'
        })
    else:
        return Response({
            "status": 'logged_out'
        }, status=status.HTTP_401_UNAUTHORIZED)

# 3) Start logowania – redirect do /authorize
def login_view(request):
    redirect_uri = settings.BASE_URL + reverse("callback")
    return auth0.authorize_redirect(request, redirect_uri)

# 4) Callback – wymiana code -> tokeny i zapis usera w sesji
def callback(request):
    token = auth0.authorize_access_token(request)
    # token zawiera m.in. id_token, access_token, a często też userinfo (gdy scope=profile,email)
    userinfo = token.get("userinfo")
    id_token = token.get("id_token")

    if not userinfo and id_token:
        # awaryjnie: odczytaj claims bez weryfikacji (Authlib i tak zweryfikował po stronie OIDC)
        claims = jwt.get_unverified_claims(id_token)
        userinfo = {
            "sub": claims.get("sub"),
            "name": claims.get("name") or claims.get("nickname"),
            "email": claims.get("email"),
        }

    request.session["user"] = userinfo
    request.session["id_token"] = id_token
    request.session["access_token"] = token.get("access_token")
    return redirect("index")

# 5) Wylogowanie – czyść sesję + redirect do /v2/logout
def logout_view(request):
    request.session.flush()
    return_to = settings.BASE_URL + reverse("index")
    url = (
        f"https://{settings.AUTH0_DOMAIN}/v2/logout"
        f"?client_id={settings.AUTH0_CLIENT_ID}"
        f"&returnTo={return_to}"
    )
    return HttpResponseRedirect(url)

# 6) Prosty „guard” do widoków HTML
def login_required(view_func):
    @wraps(view_func)
    def _wrapped(request, *args, **kwargs):
        if "user" not in request.session:
            return redirect("login")
        return view_func(request, *args, **kwargs)
    return _wrapped

# 7) Strona chroniona – profil
@login_required
def profile(request):
    return JsonResponse({
        "user": request.session.get("user"),
        "has_access_token": bool(request.session.get("access_token")),
        "has_id_token": bool(request.session.get("id_token")),
    })

# 8) (Opcjonalnie) API chronione Access Tokenem (JWT) w nagłówku Authorization
def requires_auth_api(view_func):
    @wraps(view_func)
    def _wrapped(request, *args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JsonResponse({"message": "Missing or invalid Authorization header"}, status=401)

        token = auth_header.split(" ", 1)[1]

        # Produkcyjnie: pobierz i cache'uj JWKS z:
        # https://<AUTH0_DOMAIN>/.well-known/jwks.json
        # i podstaw właściwy klucz publiczny wg 'kid'.
        try:
            jwt.decode(
                token,
                key=None,                     # <- tu wstaw klucz z JWKS
                algorithms=["RS256"],
                audience=settings.AUTH0_AUDIENCE,
                issuer=f"https://{settings.AUTH0_DOMAIN}/",
            )
        except JWTError:
            return JsonResponse({"message": "Invalid token"}, status=401)

        return view_func(request, *args, **kwargs)
    return _wrapped

@requires_auth_api
def api_private(request):
    return JsonResponse({"message": "Tajny zasób API dla prawidłowego Access Tokena"})