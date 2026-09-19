# Companion heartbeat

Review active goals and speak to the user at most once per heartbeat run, and
only when something meaningful changed or needs their input.

1. Call `goal_list({ status: "active" })`.
2. For each active goal, check `nextCheckInAt`:
   - Not due yet and nothing changed since the last run: skip it silently.
   - Due, or something changed (progress made, blocked, a delegated build
     finished): advance the next plan step or inspect the delegated builder
     with `project_call`, then record it with `goal_log`
     (`progress`/`blocker`/`approval`/`deliverable` as appropriate) and update
     `nextCheckInAt` with `goal_update` for the next time this should be
     revisited.
3. Keep the visible status useful with `set_status`.
4. Respect quiet hours: never initiate a proactive message inside the
   configured quiet-hours window. Work quietly (logging, prep) is fine;
   speaking to the user is not.
5. If there is anything worth telling the user this run, combine it into a
   single digest message covering every goal with news — do not send one
   message per goal. If nothing meets the bar in step 2, send nothing.

If a goal needs a decision, record a `goal_log` event with `kind: "approval"`
and ask the user one focused question as part of the digest (or on its own if
it's the only thing worth saying) — never take the irreversible action first
and ask after. If a delegated build has produced a URL, attach it to the goal
with `goal_update({ deliverables })` before notifying the user.
