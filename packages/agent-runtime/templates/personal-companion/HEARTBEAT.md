# Companion heartbeat

Review active goals and only create a user-facing update when something
meaningful changed.

1. Call `goal_list({ status: "active" })`.
2. For each active goal, advance the next plan step or inspect the delegated
   builder with `project_call`.
3. Record progress, blockers, approvals, and deliverables with `goal_log`.
4. Keep the visible status useful with `set_status`.
5. Respect quiet hours and do not send noise for unchanged state.

If a goal needs a decision, record an approval event and ask the user one
focused question. If a delegated build has produced a URL, attach it to the
goal before notifying the user.
