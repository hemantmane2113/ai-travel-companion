"""Sign in with an outside account (Google, GitHub).

Each provider turns its own answer into one ExternalProfile; the rest of the app never
sees provider-specific data. A provider is offered only when its keys are configured.
Adding another (Microsoft, Facebook) means adding one entry here.
"""

from dataclasses import dataclass
from typing import Any

from authlib.integrations.starlette_client import OAuth, StarletteOAuth2App

from app.config import Settings


class SignInFailed(Exception):
    """The provider did not give us what we need. The message is safe to show."""


@dataclass(frozen=True)
class ExternalProfile:
    provider: str
    subject: str  # the provider's stable id for the person
    email: str | None
    email_verified: bool
    name: str | None


@dataclass(frozen=True)
class SignInProvider:
    name: str
    label: str
    # Whether the provider's "verified" flag on an email can be trusted to link the
    # sign-in to an existing account with that email. Only for providers that verify
    # ownership of the address themselves.
    links_by_verified_email: bool


GOOGLE = SignInProvider("google", "Google", links_by_verified_email=True)
GITHUB = SignInProvider("github", "GitHub", links_by_verified_email=True)
ALL = (GOOGLE, GITHUB)


def _credentials(settings: Settings, provider: SignInProvider) -> tuple[str, str] | None:
    client_id = getattr(settings, f"{provider.name}_client_id")
    secret = getattr(settings, f"{provider.name}_client_secret")
    return (client_id, secret) if client_id and secret else None


def build_oauth(settings: Settings) -> tuple[OAuth, list[SignInProvider]]:
    """The OAuth clients for every provider with keys configured, in display order."""
    oauth = OAuth()
    enabled = []
    for provider in ALL:
        credentials = _credentials(settings, provider)
        if credentials is None:
            continue
        client_id, secret = credentials
        if provider is GOOGLE:
            oauth.register(
                "google",
                client_id=client_id,
                client_secret=secret,
                server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
                client_kwargs={"scope": "openid email profile"},
            )
        elif provider is GITHUB:
            oauth.register(
                "github",
                client_id=client_id,
                client_secret=secret,
                authorize_url="https://github.com/login/oauth/authorize",
                access_token_url="https://github.com/login/oauth/access_token",
                api_base_url="https://api.github.com/",
                client_kwargs={"scope": "read:user user:email"},
            )
        enabled.append(provider)
    return oauth, enabled


async def fetch_profile(provider: SignInProvider, client: StarletteOAuth2App, token: dict[str, Any]) -> ExternalProfile:
    if provider is GOOGLE:
        info = token.get("userinfo") or await client.userinfo(token=token)
        if not info or not info.get("sub"):
            raise SignInFailed("Google did not say who you are.")
        return ExternalProfile(
            provider="google",
            subject=str(info["sub"]),
            email=info.get("email"),
            email_verified=bool(info.get("email_verified")),
            name=info.get("name"),
        )
    if provider is GITHUB:
        user = (await client.get("user", token=token)).json()
        if not user.get("id"):
            raise SignInFailed("GitHub did not say who you are.")
        # The profile email may be hidden or unverified; the emails list says which is
        # the primary address and whether GitHub has verified it.
        emails = (await client.get("user/emails", token=token)).json()
        primary = next((e for e in emails if isinstance(e, dict) and e.get("primary")), None) if isinstance(emails, list) else None
        return ExternalProfile(
            provider="github",
            subject=str(user["id"]),
            email=primary.get("email") if primary else None,
            email_verified=bool(primary and primary.get("verified")),
            name=user.get("name") or user.get("login"),
        )
    raise SignInFailed("That sign-in method is not available.")
