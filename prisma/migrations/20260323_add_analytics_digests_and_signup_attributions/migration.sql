-- CreateTable: analytics_digests
CREATE TABLE "analytics_digests" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "period" TEXT NOT NULL DEFAULT '24h',
    "funnelSignups" INTEGER NOT NULL DEFAULT 0,
    "funnelOnboarded" INTEGER NOT NULL DEFAULT 0,
    "funnelCreatedProject" INTEGER NOT NULL DEFAULT 0,
    "funnelSentMessage" INTEGER NOT NULL DEFAULT 0,
    "funnelEngaged" INTEGER NOT NULL DEFAULT 0,
    "avgMinToFirstProject" DOUBLE PRECISION,
    "avgMinToFirstMessage" DOUBLE PRECISION,
    "activeUsers" INTEGER NOT NULL DEFAULT 0,
    "totalMessages" INTEGER NOT NULL DEFAULT 0,
    "totalSessions" INTEGER NOT NULL DEFAULT 0,
    "totalToolCalls" INTEGER NOT NULL DEFAULT 0,
    "totalCreditsUsed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "templateStats" JSONB,
    "chunksProcessed" INTEGER NOT NULL DEFAULT 1,
    "messagesAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "aiInsights" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_digests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "analytics_digests_date_period_key" ON "analytics_digests"("date", "period");

-- CreateTable: signup_attributions
CREATE TABLE "signup_attributions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "referrer" TEXT,
    "landingPage" TEXT,
    "signupMethod" TEXT,
    "sourceTag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_attributions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signup_attributions_userId_key" ON "signup_attributions"("userId");
CREATE INDEX "signup_attributions_sourceTag_idx" ON "signup_attributions"("sourceTag");
CREATE INDEX "signup_attributions_createdAt_idx" ON "signup_attributions"("createdAt");

ALTER TABLE "signup_attributions" ADD CONSTRAINT "signup_attributions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: create signup_attributions for existing users from accounts table
-- Uses DISTINCT ON to handle users with multiple accounts (e.g. email + google)
INSERT INTO "signup_attributions" ("id", "userId", "signupMethod", "sourceTag", "createdAt")
SELECT
    gen_random_uuid(),
    sub."userId",
    sub."signupMethod",
    sub."sourceTag",
    sub."createdAt"
FROM (
    SELECT DISTINCT ON (u."id")
        u."id" AS "userId",
        CASE WHEN a."providerId" = 'google' THEN 'google' ELSE 'email' END AS "signupMethod",
        CASE WHEN a."providerId" = 'google' THEN 'google-oauth' ELSE 'direct' END AS "sourceTag",
        u."createdAt"
    FROM "users" u
    LEFT JOIN "accounts" a ON a."userId" = u."id"
    ORDER BY u."id", CASE WHEN a."providerId" = 'google' THEN 0 ELSE 1 END
) sub
WHERE NOT EXISTS (SELECT 1 FROM "signup_attributions" sa WHERE sa."userId" = sub."userId");
