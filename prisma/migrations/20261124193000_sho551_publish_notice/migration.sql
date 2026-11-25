-- Migration: publish notice on a published environment (SHO-551)
--
-- A Postgres seed can leave rows behind: a `stage_changes` row pointing at a
-- deleted application has no FK target in the new database, so the seed skips
-- it rather than failing. That skip is reported to the user as a notice
-- ("N row(s) referencing deleted records were not copied..."), but the notice
-- was only ever returned on the publish *response* — and since SHO-542 a publish
-- answers 202 and finishes in the background, so the response carries no notice
-- and the report reached nobody.
--
-- Storing it on the environment row is what the Publishing dashboard and the
-- environment status GET read. Nullable and additive: an environment with no
-- skipped rows has no notice.

ALTER TABLE "published_environments" ADD COLUMN "publishNotice" TEXT;
