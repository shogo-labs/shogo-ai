// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/** The one rule for every async tool; tool descriptions only say that they return a task. */
export const BACKGROUND_TASKS_GUIDE = `## Background Tasks
Some work keeps running after a tool returns: a long or \`background: true\` command, a background agent, a project call with \`wait: false\`, an agent you tagged, a card you watch. Those tools return \`{ task_id, status: "running", output_file }\`.
- To block on it, call \`wait({ task_ids: [...] })\`. Pass \`until\` (a regex) to return as soon as its output matches, e.g. a server's "ready" line or a card's "Done".
- Otherwise end your turn. When a task finishes you get a \`[Task update]\` message with its result, and you continue from there.
- Read \`output_file\` for full output, \`task_list\` to see what is running, \`task_cancel\` to stop one you started.
- Start long commands with \`background: true\`, not \`&\`, \`nohup\` or a redirect to your own log: a command that detaches itself is refused, because its task would end at once and lose track of the job.
- While a task is running, \`wait\` is the only correct way to check on it. A sleep cannot see the finish early: it always spends the whole delay and then only tells you to look again — so \`exec\` steers a sleep that reads that task's output (or only sleeps) to \`wait\` and refuses a repeat, and a \`wait\` that times out twice on the same tasks returns \`stop_waiting\` instead of sleeping again. To block until a server a task started is accepting connections, use \`wait({ task_ids: [...], until: '<ready line>' })\` rather than \`sleep N && curl\`. The \`[Task update]\` arrives on its own, so ending the turn costs you nothing.
- Never start the same work again while its task is running.`
