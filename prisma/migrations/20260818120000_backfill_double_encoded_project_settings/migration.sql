-- Repair `projects.settings` rows that hold a JSON *string* instead of an object.
--
-- Every client write path builds this column with `JSON.stringify(...)` and sends
-- the resulting string. Postgres stores that as a jsonb string scalar, so Prisma
-- reads it back as a `string` and `settings?.techStackId` evaluates to undefined —
-- which silently downgraded Expo projects to the agent-runtime's `react-app`
-- default. The API now normalizes on write; this fixes rows already persisted.
--
-- Idempotent and confined to rows where `jsonb_typeof(settings) = 'string'`, so
-- correctly-shaped rows (marketplace installs) are untouched. `settings #>> '{}'`
-- extracts the scalar's text, which is the original JSON document.
--
-- Done row-by-row inside an exception block rather than as one bulk UPDATE: the
-- `::jsonb` cast raises on malformed text, which would abort the whole migration
-- over a single junk row. `IS JSON OBJECT` would be tidier but requires PG16+.
-- The affected subset is small, so the loop costs nothing meaningful.

DO $$
DECLARE
  row_rec RECORD;
  decoded jsonb;
  depth int;
BEGIN
  FOR row_rec IN
    SELECT "id", "settings"
    FROM "projects"
    WHERE "settings" IS NOT NULL
      AND jsonb_typeof("settings") = 'string'
  LOOP
    decoded := row_rec."settings";

    -- Unwrap repeatedly, mirroring parseProjectSettings() in
    -- apps/api/src/lib/project-settings.ts. One layer is all the app can
    -- produce today; the bound just keeps a pathological row from spinning.
    depth := 0;
    WHILE jsonb_typeof(decoded) = 'string' AND depth < 5 LOOP
      BEGIN
        decoded := (decoded #>> '{}')::jsonb;
      EXCEPTION WHEN others THEN
        RAISE NOTICE 'project %: settings is not valid JSON, leaving as-is', row_rec.id;
        decoded := NULL;
        EXIT;
      END;
      depth := depth + 1;
    END LOOP;

    -- A bare scalar (e.g. the string "canvas") is not a settings document;
    -- re-casting it would just produce another string scalar.
    IF decoded IS NOT NULL AND jsonb_typeof(decoded) = 'object' THEN
      UPDATE "projects" SET "settings" = decoded WHERE "id" = row_rec.id;
    END IF;
  END LOOP;
END $$;
