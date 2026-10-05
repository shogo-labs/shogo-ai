-- =============================================================================
-- Postgres extensions the platform schema depends on.
-- =============================================================================
-- Prisma migrations run as the app role (`shogo`), which isn't a superuser,
-- and these extensions aren't "trusted", so a migration's
-- `CREATE EXTENSION IF NOT EXISTS` only succeeds once the extension already
-- exists. The deploy workflow runs this file as `postgres` on each region's
-- primary before migrations. Idempotent.
--
--   vector — pgvector, for team-chat semantic search
--            (conversation_message_embeddings.embedding)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
