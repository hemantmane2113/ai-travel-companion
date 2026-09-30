from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, optional_user
from app.models import User
from app.security import hash_password, verify_password

router = APIRouter()

MIN_PASSWORD_LENGTH = 8
_email_adapter = TypeAdapter(EmailStr)


def _render(request: Request, template: str, status_code: int = 200, **context) -> HTMLResponse:
    context.setdefault("min_password_length", MIN_PASSWORD_LENGTH)
    return request.app.state.templates.TemplateResponse(request, template, context, status_code=status_code)


def _sign_in(request: Request, user: User) -> RedirectResponse:
    request.session.clear()
    request.session["user_id"] = user.id
    return RedirectResponse("/", status_code=303)


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, user: User | None = Depends(optional_user)):
    if user:
        return RedirectResponse("/", status_code=303)
    return _render(request, "login.html")


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
