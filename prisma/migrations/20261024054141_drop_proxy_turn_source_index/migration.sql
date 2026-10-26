-- Nothing reads proxy_turns by `source` alone: the analytics conversation read
-- goes through the ai_analysis_turns view with a workspace + time predicate and
-- filters `source <> 'cloud_chat'`. Dropping the index saves the insert cost on
-- a table that only ever grows.
DROP INDEX "proxy_turns_source_idx";
