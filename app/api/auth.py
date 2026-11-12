import logging

from authlib.integrations.base_client import OAuthError
from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, optional_user
from app.models import User
from app.providers import sign_in
from app.providers.sign_in import SignInFailed, fetch_profile
from app.security import hash_password, verify_password
from app.services import account_service

logger = logging.getLogger(__name__)
router = APIRouter()

# Messages for /login?error=..., so the page never echoes text from the address bar.
SIGN_IN_ERRORS = {
    "cancelled": "Sign-in was cancelled or did not finish. Try again.",
    "failed": "That sign-in did not work. Try again, or use your email and password.",
}

MIN_PASSWORD_LENGTH = 8
_email_adapter = TypeAdapter(EmailStr)


def _sign_in_buttons(request: Request) -> list[dict]:
    """Every sign-in provider, and whether it works yet.

    In development an unconfigured provider is still shown (greyed out, saying what to
    set) so it is clear the option exists. In production only working ones are shown.
    """
    enabled = {provider.name for provider in request.app.state.sign_in_providers}
    shown = request.app.state.sign_in_providers if request.app.state.settings.is_production else sign_in.ALL
    return [{"provider": provider, "enabled": provider.name in enabled} for provider in shown]


def _render(request: Request, template: str, status_code: int = 200, **context) -> HTMLResponse:
    context.setdefault("min_password_length", MIN_PASSWORD_LENGTH)
    context.setdefault("sign_in_buttons", _sign_in_buttons(request))
    return request.app.state.templates.TemplateResponse(request, template, context, status_code=status_code)


def _sign_in(request: Request, user: User) -> RedirectResponse:
    request.session.clear()
    request.session["user_id"] = user.id
    return RedirectResponse("/", status_code=303)


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, user: User | None = Depends(optional_user)):
    if user:
        return RedirectResponse("/", status_code=303)
    error = request.session.pop("sign_in_error", None) or SIGN_IN_ERRORS.get(request.query_params.get("error", ""))
    return _render(request, "login.html", error=error)


@router.post("/login", response_class=HTMLResponse)
async def login(
    request: Request,
    email: str = Form(""),
    password: str = Form(""),
    db: AsyncSession = Depends(get_db),
):
    email = email.strip().lower()
    user = await db.scalar(select(User).where(User.email == email))
    if not verify_password(user.password_hash if user else None, password):
        return _render(request, "login.html", 401, error="Wrong email or password.", email=email)
    return _sign_in(request, user)


@router.get("/register", response_class=HTMLResponse)
async def register_page(request: Request, user: User | None = Depends(optional_user)):
    if user:
        return RedirectResponse("/", status_code=303)
    return _render(request, "register.html")


@router.post("/register", response_class=HTMLResponse)
async def register(
    request: Request,
    email: str = Form(""),
    password: str = Form(""),
    db: AsyncSession = Depends(get_db),
):
    email = email.strip().lower()
    try:
        _email_adapter.validate_python(email)
    except ValidationError:
        return _render(request, "register.html", 400, error="Enter a valid email address.", email=email)
    if len(password) < MIN_PASSWORD_LENGTH:
        error = f"Use a password of at least {MIN_PASSWORD_LENGTH} characters."
        return _render(request, "register.html", 400, error=error, email=email)

    user = User(email=email, password_hash=hash_password(password))
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        error = "An account with that email already exists."
        return _render(request, "register.html", 409, error=error, email=email)
    return _sign_in(request, user)


@router.post("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


# ---------- sign in with Google, GitHub ----------


def _provider(request: Request, name: str):
    provider = next((p for p in request.app.state.sign_in_providers if p.name == name), None)
    if provider is None:
        raise HTTPException(404, "That sign-in method is not available.")
    return provider, request.app.state.oauth.create_client(name)


@router.get("/auth/{name}/start")
async def oauth_start(request: Request, name: str):
    _, client = _provider(request, name)
    base = request.app.state.settings.public_base_url.rstrip("/")
    callback = f"{base}/auth/{name}/callback" if base else str(request.url_for("oauth_callback", name=name))
    return await client.authorize_redirect(request, callback)


@router.get("/auth/{name}/callback", name="oauth_callback")
async def oauth_callback(request: Request, name: str, db: AsyncSession = Depends(get_db)):
    provider, client = _provider(request, name)
    try:
        token = await client.authorize_access_token(request)
        profile = await fetch_profile(provider, client, token)
        user = await account_service.user_for(db, provider, profile)
    except OAuthError as exc:
        # Includes the person pressing Cancel at the provider, and a stale or forged state.
        logger.info("%s sign-in not completed: %s", name, exc.error)
        return RedirectResponse("/login?error=cancelled", status_code=303)
    except SignInFailed as exc:
        request.session["sign_in_error"] = str(exc)
        return RedirectResponse("/login", status_code=303)
    except Exception:
        logger.exception("%s sign-in failed", name)
        return RedirectResponse("/login?error=failed", status_code=303)
    return _sign_in(request, user)
