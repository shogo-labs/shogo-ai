-- Thread continuity for casual (not explicitly Slack-threaded) DM chat.
-- See the doc comment on SlackUserLink.activeDmThreadTs in schema.prisma
-- and dispatchSlackMessage in apps/api/src/routes/slack-agent.ts.
ALTER TABLE "slack_user_links"
ADD COLUMN "activeDmChannelId" TEXT,
ADD COLUMN "activeDmThreadTs" TEXT;
