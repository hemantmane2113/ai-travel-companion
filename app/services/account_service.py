"""Which of our users an outside sign-in belongs to."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, UserIdentity
from app.providers.sign_in import ExternalProfile, SignInFailed, SignInProvider


async def user_for(db: AsyncSession, provider: SignInProvider, profile: ExternalProfile) -> User:
    """The user this sign-in belongs to, linking or creating one as needed.

    1. A sign-in seen before goes to the same user, whatever its email is now.
    2. Otherwise it needs an email the provider has verified. It joins the account with
       that email if the provider can be trusted to have checked ownership, or becomes
       a new account. An unverified email never joins an existing account: anyone can
       type someone else's address into a provider profile.
    """
    identity = await db.scalar(
        select(UserIdentity).where(UserIdentity.provider == profile.provider, UserIdentity.subject == profile.subject)
    )
    if identity is not None:
        user = await db.get(User, identity.user_id)
        if user is not None:
            return user

    if not profile.email or not profile.email_verified:
        raise SignInFailed(
            f"Your {provider.label} account has no verified email address, so it cannot be used to sign in here. "
            f"Verify an email with {provider.label}, or create an account with email and password."
        )
    email = profile.email.strip().lower()
    user = await db.scalar(select(User).where(User.email == email))
    if user is not None and not provider.links_by_verified_email:
        raise SignInFailed(
            f"An account with {email} already exists. Sign in with your password, then link {provider.label}."
        )
    if user is None:
        user = User(email=email, password_hash=None, display_name=(profile.name or "")[:200] or None)
        db.add(user)
        await db.flush()
    elif not user.display_name and profile.name:
        user.display_name = profile.name[:200]
    db.add(UserIdentity(user_id=user.id, provider=profile.provider, subject=profile.subject, email=email))
    await db.commit()
    return user
