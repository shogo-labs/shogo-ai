-- What the marketing site sent the visitor to build (SHO-614).
--
-- A visitor types an idea in the hero input on shogo.ai and is sent to
-- `/sign-up?prompt=…`. The app captures it into a first-party cookie that
-- rides the sign-up request, and `user.create.after` stores the validated
-- JSON here — which is what survives verifying the email on another device,
-- where there is no localStorage.
--
-- Text, not jsonb, so the PostgreSQL and SQLite tracks share one read/write
-- path (same reason as `buddyLook`). Nullable and additive: every existing
-- account has no intent, and `POST /api/onboarding/complete` clears it.

ALTER TABLE "users" ADD COLUMN "signupIntent" TEXT;
