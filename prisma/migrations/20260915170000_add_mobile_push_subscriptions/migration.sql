CREATE TABLE "mobile_push_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobile_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mobile_push_subscriptions_pushToken_key" ON "mobile_push_subscriptions"("pushToken");
CREATE INDEX "mobile_push_subscriptions_userId_idx" ON "mobile_push_subscriptions"("userId");

ALTER TABLE "mobile_push_subscriptions" ADD CONSTRAINT "mobile_push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
