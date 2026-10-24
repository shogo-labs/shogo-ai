-- Migration: add_mobile_voip_token
-- Adds the PushKit VoIP token to mobile_push_subscriptions.
-- Mirrors prisma/migrations/20261019140000_add_mobile_voip_token.

-- AlterTable
ALTER TABLE "mobile_push_subscriptions" ADD COLUMN "voipToken" TEXT;
