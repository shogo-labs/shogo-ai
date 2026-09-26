# Personal-agent mobile follow-ups

This document records the product and backend work found during the mobile
viewport audit that should not be implemented as a client-only workaround.

## Reminder push notifications

### Current gap

The `reminder-manage` skill stores reminders in the agent's reminder store and
can send through an already-connected channel. The scheduled dispatch path
(`apps/api/src/jobs/run-agent-schedule-dispatch.ts`) does not create a user
notification or call `sendPushToUser`. The mobile push payload currently
assumes `chat-complete`, so the personal agent is correct not to promise a
reminder push today.

### Proposed contract

1. Persist reminders with `workspaceId`, `userId`, `dueAtUtc`, `timezone`,
   `recurrence`, `title`, `status`, `lastDeliveredAt`, and an idempotency key.
2. When the scheduler claims a due reminder, create one notification with
   `type: "reminder_due"` and `actionUrl: "/(app)/activity?reminder=<id>"`.
3. Send the notification through the existing mobile-push subscription table
   with a dedicated payload:

   ```json
   {
     "type": "reminder-due",
     "notificationId": "notification-id",
     "reminderId": "reminder-id",
     "title": "Reminder",
     "body": "Review the launch checklist"
   }
   ```

4. Claim and delivery must be idempotent. A retry can send the push again only
   when the first attempt was not durably recorded; it must not create duplicate
   notification rows.
5. Respect the user's timezone and a configurable quiet-hours window. A
   reminder remains due during quiet hours and is delivered at the next allowed
   time.
6. Add a `reminder_due` notification preference, native click routing, and a
   web fallback that opens the inbox or activity deep link.
7. Update the personal-agent manifest and skill instructions to say:
   “I can schedule reminders and Shogo will notify you in the app when they
   are due.” The agent should never claim it can send a push immediately unless
   the reminder was successfully persisted.

### Acceptance criteria

- A reminder created from personal chat appears in the notification inbox at
  its due time.
- A registered iOS/Android device receives one push with the reminder title.
- Tapping the push opens the matching reminder or activity item.
- Quiet hours, timezone conversion, retries, and duplicate scheduler runs are
  covered by server tests.

## Shared personal channels

### Product boundary

Personal workspaces should use Shogo-owned channel applications as a normal
SaaS feature. Team and dev workspaces retain the existing bring-your-own-bot
configuration in `ChannelsPanel` and `channel_connect`.

### Linking flow

- Telegram: a one-tap deep link to the Shogo bot with a short-lived,
  single-use link token.
- WhatsApp: a Shogo-owned Business number with a one-time link code shown in
  the app and confirmed from the user's WhatsApp conversation.
- Slack: “Add Shogo to Slack” OAuth, with the personal user as the installation
  owner and a clear DM-only default.

All three flows should render a connection card in the personal workspace.
The agent should offer the card or open the linking surface, not explain bot
tokens, phone-number IDs, verify tokens, or webhook deployment.

### Backend requirements

1. Add a user-owned `PersonalChannelConnection` record with provider,
   external account ID, encrypted provider metadata, status, and linked
   `workspaceId`.
2. Route inbound messages by the verified external identity to the user's
   personal workspace. Never use a process-global singleton as the ownership
   boundary.
3. Encrypt credentials at rest, redact them from runtime tool results, rotate
   link tokens, and provide disconnect/revoke behavior.
4. Preserve the existing workspace/project channel adapter for team/dev
   workspaces. Personal connections must not make a team workspace receive a
   personal message.
5. Add webhook verification, replay protection, rate limits, and an audit
   event for link, unlink, inbound, and outbound actions.

### Acceptance criteria

- A new personal user can connect each channel without supplying credentials.
- A message sent to the linked channel reaches the user's personal agent and
  the reply returns to the same conversation.
- Multiple users can use the shared applications concurrently without
  cross-account routing.
- Disconnecting removes the route and revokes the provider installation.

## Personal-agent browser access

### Current gap

The runtime advertises the browser guide, while
`filterSubagentOnlyTools` removes browser from the main personal agent and
personal orchestration is disabled. This creates the “I cannot open it” /
“I can browse” contradiction.

### Proposed scope

Enable a constrained browser tool directly for the personal agent, subject to
an explicit user capability toggle:

- isolated, stateless browser context by default;
- no access to the user's existing cookies, passwords, or local filesystem;
- navigation, text extraction, screenshots, and links only;
- downloads, arbitrary code execution, authenticated account actions, and
  destructive form submission require a user confirmation;
- domain allow/deny policy and per-turn time/resource budgets;
- a visible “Browsing…” activity row with the current domain and a stop
  action.

The runtime changes belong in `capability-profiles.ts`, `gateway-tools.ts`,
`system-manifest.ts`, and the personal template. The chat UI should reuse the
existing `BrowserWidget` and open screenshots in the in-app image viewer,
rather than sending the user to a new tab.

### Acceptance criteria

- “Open jev” produces a browser activity row and a screenshot/link result when
  the site is reachable.
- The agent accurately reports blocked actions and does not claim that a
  browser is available when the capability is disabled.
- Browser contexts cannot read existing app cookies or local files.
- User confirmation is required before an external side effect.
- Personal browser usage is logged with domain, action, outcome, and redacted
  error details.
