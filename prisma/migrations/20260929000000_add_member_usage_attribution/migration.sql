-- Add durable member attribution and code-change counters to tool calls.
ALTER TABLE "tool_call_logs" ADD COLUMN "userId" TEXT;
ALTER TABLE "tool_call_logs" ADD COLUMN "linesAdded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tool_call_logs" ADD COLUMN "linesRemoved" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "tool_call_logs_userId_createdAt_idx"
  ON "tool_call_logs"("userId", "createdAt");
