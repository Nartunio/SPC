from django.db import models


class UserIdentity(models.Model):
	"""Maps Auth0 subject identifiers to a normalized email.

	Multiple subs can correspond to the same email (e.g., social + password).
	"""
	email = models.CharField(max_length=320, db_index=True)
	sub = models.CharField(max_length=255, unique=True)
	created_at = models.DateTimeField(auto_now_add=True)
	updated_at = models.DateTimeField(auto_now=True)

	class Meta:
		unique_together = ("email", "sub")
