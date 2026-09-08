"""Request/response models for auth. Field names mirror the Next.js session
payload (camelCase) so the Angular client is unchanged across the cutover."""

from pydantic import BaseModel


class LoginRequest(BaseModel):
    email: str
    password: str


class SessionUser(BaseModel):
    userId: str
    email: str
    name: str
    role: str
    studentId: str | None = None
    mentorId: str | None = None
    # Resolved LIVE on every /login and /me from the role baseline plus any
    # grants — never carried in the JWT, so a revocation takes effect on the
    # next request rather than the next sign-in. The client renders its nav
    # and its route guards from this list; the API re-decides every call.
    capabilities: list[str] = []
