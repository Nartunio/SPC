from django.contrib import admin
from django.urls import path, include

from . import views

urlpatterns = [
    path('public', views.public),
    path('private', views.private),
    path('private-scoped', views.private_scoped)
]
