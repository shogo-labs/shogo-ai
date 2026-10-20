// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Polling workers shared by the cloud composer (`server.ts`) and the slim
 * desktop composer (`local-server.ts`).
 *
 * The list lives here so the two entrypoints cannot drift apart again. They
 * did: the heartbeat scheduler was started from `server.ts` only, so a desktop
 * boot wrote `agent_configs.nextHeartbeatAt` and never read it back.
 */
import type { RuntimeManager } from '../jobs/agent-turn-runner'
import { startAgentScheduleWorker, stopAgentScheduleWorker } from '../jobs/run-agent-schedule-dispatch'
import { startEventDeliveryWorker, stopEventDeliveryWorker } from '../jobs/run-event-delivery-dispatch'
import { startChatQueueWorker, stopChatQueueWorker } from '../jobs/run-chat-queue-drain'
import { startChannelWorkers, stopChannelWorkers } from '../jobs/run-channel-workers'
import { getLocalHeartbeatScheduler, startLocalHeartbeatScheduler } from './local-heartbeat-scheduler'
import { startSocialRelayConsumer, stopSocialRelayConsumer } from '../services/social/relay-consumer'

export interface LocalBackgroundWorkersOptions {
  /** Wakes a sleeping project when one of its heartbeats comes due. */
  runtimeManager: RuntimeManager
}

/**
 * Start every worker the API process polls with. Idempotent: each worker
 * returns early when it is already running.
 *
 * Never rejects — a scheduler that fails to start is logged and the API keeps
 * booting, because a heartbeat is never worth an unbootable server.
 */
export async function startLocalBackgroundWorkers({
  runtimeManager,
}: LocalBackgroundWorkersOptions): Promise<void> {
  // Fire due agent-owned recurring schedules in the workspace runtime.
  startAgentScheduleWorker(runtimeManager)
  // Deliver workspace events to their subscriptions. The desktop has no public
  // URL for Composio webhooks, so it receives trigger events over Composio's
  // realtime channel.
  startEventDeliveryWorker(runtimeManager)
  startChatQueueWorker()
  startChannelWorkers()
  // Relayed Zernio events for this machine's local workspaces: the cloud
  // verified and stored them, this applies them locally and acks. A no-op
  // unless this process is a desktop in relay mode.
  startSocialRelayConsumer()
  try {
    await startLocalHeartbeatScheduler(runtimeManager)
  } catch (err: any) {
    console.warn('[LocalHeartbeat] Failed to start (non-fatal):', err?.message ?? err)
  }
}

/** Stop all of them, so a SIGTERM leaves no interval behind. */
export function stopLocalBackgroundWorkers(): void {
  stopAgentScheduleWorker()
  stopEventDeliveryWorker()
  stopChatQueueWorker()
  stopChannelWorkers()
  stopSocialRelayConsumer()
  getLocalHeartbeatScheduler().stop()
}
