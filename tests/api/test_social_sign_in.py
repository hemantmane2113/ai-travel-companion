"""Sign in with Google or GitHub. The providers are faked; the linking rules are real."""

from types import SimpleNamespace

import pytest
from authlib.integrations.base_client import OAuthError
from sqlalchemy import select

from app.models import User, UserIdentity
from app.providers.sign_in import GITHUB, GOOGLE, ExternalProfile, SignInFailed, SignInProvider
from app.services import account_service


def _profile(**overrides) -> ExternalProfile:
    fields = dict(provider="google", subject="g-123", email="Meera@Example.com", email_verified=True, name="Meera")
    fields.update(overrides)
    return ExternalProfile(**fields)


# ---------- which account a sign-in belongs to ----------


async def test_a_new_person_gets_an_account_without_a_password(session_factory):
    async with session_factory() as db:
        user = await account_service.user_for(db, GOOGLE, _profile())
        assert (user.email, user.password_hash, user.display_name) == ("meera@example.com", None, "Meera")


async def test_the_same_provider_account_returns_even_after_its_email_changes(session_factory):
    async with session_factory() as db:
        first = await account_service.user_for(db, GOOGLE, _profile())
        again = await account_service.user_for(db, GOOGLE, _profile(email="new@example.com"))
        assert again.id == first.id


async def test_a_verified_email_joins_the_existing_account(anon, session_factory):
    await anon.post("/register", data={"email": "meera@example.com", "password": "correct-horse"})
    async with session_factory() as db:
        user = await account_service.user_for(db, GITHUB, _profile(provider="github", subject="77"))
        assert user.password_hash is not None  # the account made with a password
        identities = (await db.scalars(select(UserIdentity))).all()
        assert [(i.provider, i.subject, i.user_id) for i in identities] == [("github", "77", user.id)]


@pytest.mark.parametrize("email, verified", [(None, False), ("meera@example.com", False)])
async def test_no_verified_email_no_sign_in(session_factory, email, verified):
    async with session_factory() as db:
        with pytest.raises(SignInFailed, match="no verified email"):
            await account_service.user_for(db, GOOGLE, _profile(email=email, email_verified=verified))
        assert (await db.scalars(select(User))).all() == []


async def test_an_untrusted_provider_never_takes_over_an_existing_account(anon, session_factory):
    await anon.post("/register", data={"email": "meera@example.com", "password": "correct-horse"})
    cautious = SignInProvider("other", "Other", links_by_verified_email=False)
    async with session_factory() as db:
        with pytest.raises(SignInFailed, match="already exists"):
            await account_service.user_for(db, cautious, _profile(provider="other"))


# ---------- the pages ----------


class FakeClient:
    """Stands in for Authlib's client: the provider's answers are scripted."""

    def __init__(self, token=None, error=None):
        self.token, self.error = token, error

    async def authorize_redirect(self, request, redirect_uri):
        from fastapi.responses import RedirectResponse

        return RedirectResponse(f"https://accounts.example/authorize?redirect_uri={redirect_uri}", status_code=302)

    async def authorize_access_token(self, request):
        if self.error:
            raise self.error
        return self.token


def _offer_google(app, client: FakeClient):
    app.state.sign_in_providers = [GOOGLE]
    app.state.oauth = SimpleNamespace(create_client=lambda name: client)


async def test_unconfigured_providers_show_how_to_set_them_up(app, anon):
    page = (await anon.get("/register")).text
    assert "Continue with Google" in page and "Continue with GitHub" in page
    assert 'href="/auth/' not in page and "GOOGLE_CLIENT_ID" in page  # greyed out, with the setting to add
    assert (await anon.get("/auth/google/start")).status_code == 404

    app.state.settings.app_env = "production"  # visitors never see buttons that do nothing
    assert "Continue with Google" not in (await anon.get("/login")).text


async def test_a_configured_provider_gets_a_working_button(app, anon):
    _offer_google(app, FakeClient())
    page = (await anon.get("/login")).text
    assert 'href="/auth/google/start"' in page and 'href="/auth/github/start"' not in page
    assert "GITHUB_CLIENT_ID" in page  # GitHub is still waiting for its keys
    start = await anon.get("/auth/google/start")
    assert start.status_code == 302 and "redirect_uri=http://test/auth/google/callback" in start.headers["location"]


async def test_a_completed_google_sign_in_opens_the_app(app, anon):
    token = {"userinfo": {"sub": "g-123", "email": "meera@example.com", "email_verified": True, "name": "Meera"}}
    _offer_google(app, FakeClient(token=token))

    response = await anon.get("/auth/google/callback?code=x&state=y")
    assert response.status_code == 303 and response.headers["location"] == "/"
    home = await anon.get("/")
    assert home.status_code == 200 and "Meera" in home.text


async def test_a_cancelled_or_refused_sign_in_explains_itself(app, anon):
    _offer_google(app, FakeClient(error=OAuthError(error="access_denied")))
    response = await anon.get("/auth/google/callback?error=access_denied")
    assert response.headers["location"] == "/login?error=cancelled"
    assert "Sign-in was cancelled" in (await anon.get("/login?error=cancelled")).text

    _offer_google(app, FakeClient(token={"userinfo": {"sub": "g-9", "email": "x@example.com", "email_verified": False}}))
    response = await anon.get("/auth/google/callback?code=x&state=y")
    assert response.headers["location"] == "/login"
    assert "no verified email address" in (await anon.get("/login")).text


async def test_the_login_page_never_echoes_its_address_bar(anon):
    page = (await anon.get("/login?error=<script>alert(1)</script>")).text
    assert "<script>alert" not in page
