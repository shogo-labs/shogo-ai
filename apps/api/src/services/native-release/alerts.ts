// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Ops alerts for native release.
 *
 * Native release is the first surface where a silent failure charges a customer
 * or drops their money on the floor — an unpriced build, a build on the Shogo
 * account that has no row, a signing certificate that could not be created. The
 * cost of those being invisible is higher than the cost of a noisy log line, so
 * each one is a single structured event with a stable code.
 *
 * `SHOGO_OPS_ALERT_WEBHOOK` forwards the same event to Slack/whatever is
 * configured; without it the event is only logged, which is still better than a
 * swallowed exception.
 */

export type NativeOpsEvent =
  | 'native_build_unknown'
  | 'native_build_unpriced'
  | 'native_app_capacity'
  | 'native_signing_failed'
  | 'native_workflow_failed'
  | 'native_submission_failed'
  | 'native_webhook_unrecognised'
  | 'native_meter_sweep'

let alertOverride: ((event: NativeOpsEvent, detail: Record<string, unknown>) => Promise<void>) | null =
  null

/** Test seam: collect alerts instead of logging them. */
export function setNativeAlertSink(
  sink: ((event: NativeOpsEvent, detail: Record<string, unknown>) => Promise<void>) | null,
): void {
  alertOverride = sink
}

export async function alertOps(event: NativeOpsEvent, detail: Record<string, unknown>): Promise<void> {
  if (alertOverride) {
    await alertOverride(event, detail)
    return
  }

  console.error(`[native-release][alert] ${event}`, JSON.stringify(detail))

  const url = process.env.SHOGO_OPS_ALERT_WEBHOOK
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `native-release ${event}`, event, detail }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch (err) {
    console.error('[native-release][alert] forward failed', err)
  }
}
