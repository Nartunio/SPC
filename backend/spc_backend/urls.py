from django.contrib import admin
from django.urls import path
from core import views

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", views.index, name="index"),
    path("login/", views.login_view, name="login"),
    path("callback/", views.callback, name="callback"),
    path("logout/", views.logout_view, name="logout"),
    path("profile/", views.profile, name="profile"),
    path("api/private/", views.api_private, name="api_private"),
]