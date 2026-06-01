-- ---------------------------------------------------------------------------
-- Table-ownership contract — applied to each region's primary on every deploy,
-- BEFORE `prisma migrate deploy` runs (see .github/workflows/deploy.yml).
--
-- Why this file exists
-- ====================
-- Migrations run as the unprivileged role `shogo`. `ALTER TABLE` (e.g.
-- `ADD COLUMN`) requires the issuing role to *own* the table. DDL is NOT
-- propagated by logical replication, so each region creates its own schema
-- locally — normally via `prisma migrate deploy` as `shogo`, which makes
-- `shogo` the owner. But any ad-hoc `CREATE TABLE` run as `postgres` on a
-- secondary (e.g. an operator manually creating a table to unblock a
-- crash-looping apply worker) leaves a `postgres`-owned table behind. The
-- next migration that `ALTER`s that table then fails with:
--
--   ERROR: must be owner of table <name>            (SQLSTATE 42501)
--
-- which marks the migration failed and wedges every later deploy on that
-- cluster with P3009 (2026-05-31 incident: `affiliate_commission_tiers` and
-- 9 sibling tables were `postgres`-owned on EU + India).
--
-- This script makes "shogo owns every table in public" a structural property
-- of the schema, exactly mirroring the GRANT contract in grants.sql:
--
--   1. Sweep — reassign every table / sequence in `public` not already owned
--      by `shogo` to `shogo` (no-op if already correct).
--   2. Event trigger — belt-and-suspenders. Fires on every `CREATE TABLE` in
--      `public` regardless of which role issued the DDL, and reassigns the
--      new table to `shogo`. Wrapped in an EXCEPTION handler so a failure can
--      NEVER block a migration.
--   3. Audit — surface any remaining drift as a WARNING.
--
-- Idempotent and safe to run repeatedly. The sweep is surgical: it touches
-- ONLY relations in `public`, never `REASSIGN OWNED BY postgres` (which would
-- also rip ownership off system catalogs and extension objects).
--
-- Run as `postgres` (superuser) — reassigning ownership and creating an event
-- trigger both require superuser, and ALTER ... OWNER TO <role> requires
-- membership in the target role.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- Guard: if the role doesn't exist yet (very first cluster bootstrap, before
-- CNPG's managed.roles reconciler has run), exit cleanly. By the time
-- deploy.yml invokes this script in steady state, the role exists; this
-- branch only protects against extreme bootstrap ordering.
SELECT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'shogo'
) AS role_present \gset
\if :role_present
\else
  \echo 'skipping: shogo role not present yet'
  \quit
\endif

-- ---------------------------------------------------------------------------
-- 1. Sweep current state.
--
-- Reassign every table (relkind 'r' ordinary, 'p' partitioned) and sequence
-- (relkind 'S') in `public` whose owner is not already `shogo`. Sequences are
-- included because a `postgres`-owned identity/serial sequence backing a
-- `shogo`-owned table would block `ALTER SEQUENCE` in a future migration the
-- same way. Each statement is run via dynamic SQL so a single unexpected
-- object can't abort the whole sweep silently — failures raise immediately
-- under ON_ERROR_STOP, which is what we want before a migration gate.
-- ---------------------------------------------------------------------------
DO $sweep$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT n.nspname,
           c.relname,
           c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'S')
      AND c.relowner <> 'shogo'::regrole
  LOOP
    IF obj.relkind = 'S' THEN
      EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO shogo', obj.nspname, obj.relname);
    ELSE
      EXECUTE format('ALTER TABLE %I.%I OWNER TO shogo', obj.nspname, obj.relname);
    END IF;
    RAISE NOTICE 'reassigned % %.% to shogo', obj.relkind, obj.nspname, obj.relname;
  END LOOP;
END
$sweep$;

-- ---------------------------------------------------------------------------
-- 2. Event trigger — runs inside the database on every CREATE TABLE
-- regardless of which role issued the DDL. This is the durable contract:
-- a table created by `postgres` (or any non-shogo role) is reassigned to
-- `shogo` atomically with its creation, so a later migration that ALTERs it
-- never hits `must be owner`.
--
-- SECURITY DEFINER (function owned by postgres) so the reassignment always
-- has the privilege to change ownership, even when the CREATE TABLE was
-- issued by a role that is not a member of `shogo`. A normal migration
-- `CREATE TABLE` by `shogo` is a no-op (owner already shogo).
--
-- The ALTER is wrapped in BEGIN/EXCEPTION so any failure inside the trigger
-- raises a WARNING but does NOT propagate to the outer DDL transaction. A
-- broken trigger can NEVER block a `prisma migrate deploy`. This is the
-- single most important safety property of this file.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_table_owner_shogo()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND schema_name = 'public'
      AND object_type = 'table'
  LOOP
    BEGIN
      -- Only reassign if it isn't already shogo-owned, to avoid churning a
      -- needless ALTER on the hot migration path.
      IF EXISTS (
        SELECT 1
        FROM pg_class c
        WHERE c.oid = obj.objid
          AND c.relowner <> 'shogo'::regrole
      ) THEN
        EXECUTE format('ALTER TABLE %s OWNER TO shogo', obj.object_identity);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING
        'enforce_table_owner_shogo: OWNER reassignment failed for % (%): %',
        obj.object_identity, obj.command_tag, SQLERRM;
    END;
  END LOOP;
END
$fn$;

-- Recreate the trigger so its WHEN clause / function binding always matches
-- the function definition above. DROP IF EXISTS + CREATE is idempotent.
--
-- Theoretical hole: a CREATE TABLE that lands in the microseconds between
-- DROP and CREATE would miss the trigger. Mitigated by the sweep in layer
-- (1) above which reassigns on the next deploy, and by the pre-migration
-- "Verify ownership contract" gate in deploy.yml.
DROP EVENT TRIGGER IF EXISTS enforce_table_owner_shogo_trg;
CREATE EVENT TRIGGER enforce_table_owner_shogo_trg
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION enforce_table_owner_shogo();

-- ---------------------------------------------------------------------------
-- 3. Surface drift — emit a NOTICE listing any tables in `public` that are
-- still not owned by `shogo` after the sweep above. In a healthy cluster
-- this should never print rows. If it does, that's a bug in this script or
-- an object type the sweep doesn't cover.
-- ---------------------------------------------------------------------------
DO $audit$
DECLARE
  drifted_tables text;
BEGIN
  SELECT string_agg(format('%I.%I (owner=%s)', n.nspname, c.relname, c.relowner::regrole::text), ', ')
    INTO drifted_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relowner <> 'shogo'::regrole;

  IF drifted_tables IS NOT NULL THEN
    RAISE WARNING
      'tables in public still not owned by shogo: %', drifted_tables;
  ELSE
    RAISE NOTICE 'shogo owns every table in public';
  END IF;
END
$audit$;
