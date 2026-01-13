from django.db import models
import uuid
import secrets


def _generate_share_token() -> str:
	# 160 bits of entropy, URL-safe
	return secrets.token_urlsafe(20)


class StorageShare(models.Model):
	id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
	owner_sub = models.CharField(max_length=255, db_index=True)
	target_sub = models.CharField(max_length=255, db_index=True, null=True, blank=True)
	target_email = models.CharField(max_length=320, db_index=True, null=True, blank=True)
	key = models.CharField(max_length=1024)  # key relative to owner's prefix
	is_directory = models.BooleanField(default=False)
	permission = models.CharField(max_length=16, default="read")  # read | read-write
	visibility = models.CharField(max_length=16, default="private")  # private | public | protected
	token = models.CharField(max_length=128, default=_generate_share_token, unique=True)
	allowed_emails = models.JSONField(default=list, blank=True)
	expires_at = models.DateTimeField(null=True, blank=True)
	created_at = models.DateTimeField(auto_now_add=True)


class FileVersion(models.Model):
	owner_sub = models.CharField(max_length=255, db_index=True)
	key = models.CharField(max_length=1024, db_index=True)  # logical path relative to user's prefix
	version = models.PositiveIntegerField()
	object_key = models.CharField(max_length=2048)  # actual stored object key
	size = models.BigIntegerField(null=True, blank=True)
	etag = models.CharField(max_length=128, null=True, blank=True)
	created_at = models.DateTimeField(auto_now_add=True)

	class Meta:
		unique_together = ("owner_sub", "key", "version")
		ordering = ["-version"]


class ActivityLog(models.Model):
	user_sub = models.CharField(max_length=255, db_index=True)
	action = models.CharField(max_length=64)
	key = models.CharField(max_length=2048, null=True, blank=True)
	success = models.BooleanField(default=True)
	created_at = models.DateTimeField(auto_now_add=True)
	extra = models.JSONField(default=dict, blank=True)

	class Meta:
		ordering = ["-created_at"]
