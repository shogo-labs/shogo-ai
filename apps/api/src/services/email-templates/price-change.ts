// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The v2.5.0 price-change notice (SHO-339).
 *
 * Sent once per workspace owner / billing admin by
 * `scripts/migrate-phase5-subscriptions.ts --send-notice` (or by the script's
 * marked dry run, which renders to `.tmp/` for review).
 *
 * Rules the copy follows:
 *   - Lead with the **lower price**. This is a price cut for Business, not an
 *     increase, and the email must not read like a bill shock.
 *   - Give the **exact switch date** and say nothing changes before it.
 *   - Explain the allowance in the units the customer sees: a weekly amount
 *     per seat, plus the 80% / 100% warnings and the overage path.
 *   - Basic gets the "more AI, same price" variant; a trial gets "you'll be
 *     charged $16, not $40".
 */

export interface PriceChangeEmailParams {
  workspaceName: string
  /** Display name, e.g. `Business`. */
  planName: string
  /** What the seat costs today, USD per interval. */
  fromPriceUsd: number
  /** What the seat costs after the switch, USD per interval. */
  toPriceUsd: number
  interval: 'month' | 'year'
  /** ISO date (YYYY-MM-DD) the new price takes effect. */
  switchDate: string
  /** Included AI per seat per week after the switch, USD. */
  weeklyAllowanceUsd: number
  /** True for a trial that will convert at the new price. */
  trial?: boolean
  billingUrl: string
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

function usd(n: number): string {
  return `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`
}

export function renderPriceChangeEmail(params: PriceChangeEmailParams): RenderedEmail {
  const {
    workspaceName,
    planName,
    fromPriceUsd,
    toPriceUsd,
    interval,
    switchDate,
    weeklyAllowanceUsd,
    trial,
    billingUrl,
  } = params

  const per = interval === 'month' ? 'month' : 'year'
  const cheaper = toPriceUsd < fromPriceUsd
  const unchanged = toPriceUsd === fromPriceUsd

  const subject = trial
    ? `Your ${planName} trial will be billed at ${usd(toPriceUsd)} per seat, not ${usd(fromPriceUsd)}`
    : unchanged
      ? `More included AI on your Shogo ${planName} plan — same price`
      : cheaper
        ? `Your Shogo ${planName} plan is going down to ${usd(toPriceUsd)} per seat`
        : `An update to your Shogo ${planName} plan price`

  const headline = trial
    ? `You’ll be billed ${usd(toPriceUsd)} per seat, not ${usd(fromPriceUsd)}`
    : unchanged
      ? `More included AI, same price`
      : cheaper
        ? `Your plan is getting cheaper`
        : `A change to your plan price`

  const opening = trial
    ? `When your ${planName} trial ends we'll charge <strong>${usd(toPriceUsd)} per seat per ${per}</strong> — not the ${usd(fromPriceUsd)} you signed up at. You keep every seat you added during the trial.`
    : unchanged
      ? `From <strong>${switchDate}</strong> your ${planName} plan keeps the same ${usd(toPriceUsd)} per ${per} price and gets a larger included AI allowance per seat.`
      : cheaper
        ? `From <strong>${switchDate}</strong> your ${planName} seat costs <strong>${usd(toPriceUsd)} per ${per}</strong> instead of ${usd(fromPriceUsd)}. Nothing changes before that date, and there is nothing for you to do.`
        : `From <strong>${switchDate}</strong> your ${planName} seat costs <strong>${usd(toPriceUsd)} per ${per}</strong> instead of ${usd(fromPriceUsd)}. Nothing changes before that date.`

  const allowanceLine = `Every seat includes <strong>${usd(weeklyAllowanceUsd)} of AI usage a week</strong>, with a shorter 5-hour window so one long session can't use up the week.`

  const overageLine = `If a seat reaches 80% of its weekly allowance we email you; at 100% usage pauses for that window rather than surprising you with a charge. Any usage beyond the allowance is billed as metered overage at raw provider cost plus 20%, and you can set a hard spending cap in billing at any time.`

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px;">
            <tr><td>
              <h1 style="margin:0 0 8px;font-size:22px;line-height:1.3;">${headline}</h1>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#333;">${opening}</p>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#333;">${allowanceLine}</p>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#333;">${overageLine}</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#333;">
                This applies to <strong>${workspaceName}</strong>.
              </p>
              <a href="${billingUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">Review billing</a>
              <hr style="border:none;border-top:1px solid #eaeaea;margin:28px 0 16px;">
              <p style="margin:0;font-size:13px;line-height:1.6;color:#777;">
                Questions? Reply to this email and a human will answer.
              </p>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

  const stripTags = (s: string) => s.replace(/<[^>]+>/g, '')
  const text = [
    headline,
    '',
    stripTags(opening),
    '',
    stripTags(allowanceLine),
    '',
    stripTags(overageLine),
    '',
    `This applies to ${workspaceName}.`,
    '',
    `Review billing: ${billingUrl}`,
  ].join('\n')

  return { subject, html, text }
}
