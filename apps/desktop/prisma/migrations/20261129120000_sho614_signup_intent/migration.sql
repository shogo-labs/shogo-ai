-- Local (SQLite) mirror of the cloud sign-up intent column (SHO-614).
-- See prisma/migrations/20261129120000_sho614_signup_intent for the rationale.
--
-- Additive and nullable: existing desktop databases keep working, and desktop
-- sign-up has no marketing link today, so the column is mostly here so the
-- User row round-trips between desktop and cloud with one shape.

PRAGMA foreign_keys = OFF;

ALTER TABLE "users" ADD COLUMN "signupIntent" TEXT;

PRAGMA foreign_keys = ON;
