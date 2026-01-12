from authlib.integrations.django_oauth2 import ResourceProtector
from config import validator, settings

require_auth = ResourceProtector()
token_validator = validator.Auth0JWTBearerTokenValidator(
    settings.AUTH0_DOMAIN,
    settings.AUTH0_AUDIENCE,
)
require_auth.register_token_validator(token_validator)