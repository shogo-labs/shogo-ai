-- Migration: add `tools` (structured tool descriptors) to project_agents.
--
-- The new `tools` column stores
--   `[{ name, description?, inputSchema? }]`
-- — the source of truth for both modalities. The chat route declares
-- these to streamText; the voice sync forwards them to ElevenLabs as
-- `prompt.tools`.
--
-- Existing rows have a `toolsAllowlist` of bare names (or null). The
-- backfill expands each name into a `{ "name": "<name>" }` descriptor.
-- `toolsAllowlist` is left in place for one release window so callers
-- still mid-deploy don't regress; it will be dropped in a follow-up.

ALTER TABLE "project_agents" ADD COLUMN "tools" JSONB;

-- Backfill: expand each existing toolsAllowlist string[] into the new
-- ToolDescriptor[] shape. `jsonb_build_object('name', x)` produces
-- `{ "name": "<x>" }` for every element of the source array; the
-- aggregate becomes the new `tools` array.
UPDATE "project_agents"
SET "tools" = (
  SELECT jsonb_agg(jsonb_build_object('name', elem))
  FROM jsonb_array_elements_text("toolsAllowlist") AS elem
)
WHERE "toolsAllowlist" IS NOT NULL
  AND jsonb_typeof("toolsAllowlist") = 'array'
  AND jsonb_array_length("toolsAllowlist") > 0;
