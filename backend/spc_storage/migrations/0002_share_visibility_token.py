from django.db import migrations, models
import uuid

from spc_storage.models import _generate_share_token


def populate_tokens(apps, schema_editor):
    StorageShare = apps.get_model("spc_storage", "StorageShare")
    for share in StorageShare.objects.all():
        if not share.token:
            new_token = _generate_share_token()
            while StorageShare.objects.filter(token=new_token).exists():
                new_token = _generate_share_token()
            share.token = new_token
        if not share.visibility:
            share.visibility = "private"
        if share.allowed_emails is None:
            share.allowed_emails = []
        share.save(update_fields=["token", "visibility", "allowed_emails"])


class Migration(migrations.Migration):

    dependencies = [
        ("spc_storage", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="storageshare",
            name="allowed_emails",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="storageshare",
            name="token",
            field=models.CharField(default=_generate_share_token, max_length=128, unique=True),
        ),
        migrations.AddField(
            model_name="storageshare",
            name="visibility",
            field=models.CharField(default="private", max_length=16),
        ),
        migrations.AlterField(
            model_name="storageshare",
            name="target_sub",
            field=models.CharField(blank=True, db_index=True, max_length=255, null=True),
        ),
        migrations.RunPython(populate_tokens, migrations.RunPython.noop),
    ]
