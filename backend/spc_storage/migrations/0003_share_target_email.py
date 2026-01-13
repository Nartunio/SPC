from django.db import migrations, models


def forwards(apps, schema_editor):
    StorageShare = apps.get_model('spc_storage', 'StorageShare')
    # Best effort: copy target_sub to target_email when it looks like an email
    for share in StorageShare.objects.all():
        if share.target_email:
            continue
        if share.target_sub and '@' in share.target_sub:
            share.target_email = share.target_sub.lower()
            share.save(update_fields=['target_email'])


def backwards(apps, schema_editor):
    # No-op
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('spc_storage', '0002_share_visibility_token'),
    ]

    operations = [
        migrations.AddField(
            model_name='storageshare',
            name='target_email',
            field=models.CharField(blank=True, db_index=True, max_length=320, null=True),
        ),
        migrations.RunPython(forwards, backwards),
    ]
