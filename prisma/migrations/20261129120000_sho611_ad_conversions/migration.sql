-- Ad-platform click ids and Meta's browser cookies on the signup row, plus the
-- website's PostHog distinct id (SHO-611). Every column is nullable and nothing
-- else in the table changes, so this is a pure additive migration: existing rows
-- keep their data and read as "no click id recorded".
ALTER TABLE "signup_attributions" ADD COLUMN "fbclid" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "gclid" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "fbc" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "fbp" TEXT;
ALTER TABLE "signup_attributions" ADD COLUMN "posthogDistinctId" TEXT;
