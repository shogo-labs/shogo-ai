-- ---------------------------------------------------------------------------
-- Logical replication GRANT contract — applied to each region's primary on
-- every deploy (see .github/workflows/deploy.yml).
--
-- Why this file exists
-- ====================
-- The publication (`shogo_all_pub`) uses `FOR TABLES IN SCHEMA public`, so any
-- new table created by `prisma migrate deploy` is auto-published. But Postgres
-- does NOT auto-grant SELECT on those new tables to the `logical_replicator`
-- role — and tablesync workers connect as `logical_replicator`. A missing
-- GRANT causes the worker to fail with `permission denied for table X`,
-- which respawns a fresh tablesync slot every retry, exhausts the slot pool
-- (`all replication slots are in use`), and then knocks the *healthy*
-- subscription slots offline too (`can no longer access replication slot
-- "sub_from_eu"`). One missing GRANT cascades into a cluster-wide outage.
--
-- This script makes the GRANT contract a structural property of the schema:
--
--   1. Sweep — ensure `logical_replicator` has SELECT on every existing
--      table in `public` (no-op if already granted).
--   2. ALTER DEFAULT PRIVILEGES — for every role that can CREATE TABLE in
--      `public`, declare that the GRANT happens automatically on future
--      CREATE TABLE statements issued by that role.
--   3. Event trigger — belt-and-suspenders. Fires inside the database on
--      every `CREATE TABLE` in `public` regardless of which role issued
--      it, and grants SELECT to `logical_replicator`. Wrapped in an
--      EXCEPTION handler so a GRANT failure can NEVER block a migration.
--
-- Idempotent and safe to run repeatedly. Pure additive — no DROP, REVOKE,
-- or ALTER of existing objects beyond CREATE-OR-REPLACE of the trigger
-- function (which already runs that way).
--
-- Run as `postgres` (superuser) — event trigger creation requires superuser,
-- and `ALTER DEFAULT PRIVILEGES FOR ROLE <other_role>` requires either
-- superuser or membership in the target role.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- Guard: if the role doesn't exist yet (very first cluster bootstrap, before
-- CNPG's managed.roles reconciler has run), exit cleanly. By the time
-- deploy.yml invokes this script in steady state, the role exists; this
-- branch only protects against extreme bootstrap ordering.
SELECT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'logical_replicator'
) AS role_present \gset
\if :role_present
\else
  \echo 'skipping: logical_replicator role not present yet'
  \quit
\endif

-- ---------------------------------------------------------------------------
-- 1. Sweep current state.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO logical_replicator;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO logical_replicator;

-- ---------------------------------------------------------------------------
-- 2. ALTER DEFAULT PRIVILEGES for every role that can create tables in
-- `public`. The set is small and known — extend the list if a new role is
-- introduced. Each statement is idempotent; running it a second time is a
-- no-op.
--
-- The default form (no FOR ROLE) only applies to tables created by the role
-- *running* this script (postgres). That alone is not enough, because
-- migrations run as `shogo`. We explicitly cover both.
--
-- `FOR ROLE postgres` is defensive — `postgres` does not create tables in
-- `public` in the normal migration flow. Kept as belt-and-suspenders for
-- ad-hoc operator sessions that might `CREATE TABLE` as postgres.
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE shogo    IN SCHEMA public GRANT SELECT ON TABLES TO logical_replicator;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO logical_replicator;

-- ---------------------------------------------------------------------------
-- 3. Event trigger — runs inside the database on every CREATE TABLE
-- regardless of which role issued the DDL. This is the durable contract:
-- new tables get the GRANT atomically with their creation, even if a future
-- migration is run by a role we forgot to ALTER DEFAULT PRIVILEGES for.
--
-- The GRANT is wrapped in BEGIN/EXCEPTION so any failure inside the trigger
-- raises a WARNING but does NOT propagate to the outer DDL transaction. A
-- broken trigger can NEVER block a `prisma migrate deploy`. This is the
-- single most important safety property of this file.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION grant_replicator_select_on_new_table()
RETURNS event_trigger
LANGUAGE plpgsql
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
      EXECUTE format(
        'GRANT SELECT ON %s TO logical_replicator',
        obj.object_identity
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING
        'auto_grant_replicator_select: GRANT failed for % (%): %',
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
-- (1) above which re-grants on the next deploy. Acceptable for steady-state
-- deploys; would be tighter if Postgres supported CREATE OR REPLACE EVENT
-- TRIGGER (it does not).
--
-- Coverage note: this trigger fires on CREATE TABLE (incl. PARTITION OF) but
-- NOT on `ALTER TABLE ... ATTACH PARTITION existing_table`. If an existing
-- table from outside `public` is attached, it does NOT receive the GRANT
-- automatically. We do not use ATTACH PARTITION in migrations today; if we
-- ever do, add 'ALTER TABLE' to the WHEN clause and filter on the operation
-- subtype inside the function.
DROP EVENT TRIGGER IF EXISTS auto_grant_replicator_select;
CREATE EVENT TRIGGER auto_grant_replicator_select
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION grant_replicator_select_on_new_table();

-- ---------------------------------------------------------------------------
-- 4. Surface drift — emit a NOTICE listing any tables in `public` that
-- still lack SELECT for `logical_replicator` after the sweep above. In a
-- healthy cluster this should never print rows. If it does, that's a bug
-- in this script or a privileged operator manually revoked something.
-- ---------------------------------------------------------------------------
DO $audit$
DECLARE
  missing_tables text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
    INTO missing_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT has_table_privilege('logical_replicator', c.oid, 'SELECT');

  IF missing_tables IS NOT NULL THEN
    RAISE WARNING
      'logical_replicator is still missing SELECT on: %', missing_tables;
  ELSE
    RAISE NOTICE 'logical_replicator has SELECT on every table in public';
  END IF;
END
$audit$;
