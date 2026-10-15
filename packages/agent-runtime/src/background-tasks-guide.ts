// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/** The one rule for every async tool; tool descriptions only say that they return a task. */
export const BACKGROUND_TASKS_GUIDE = `## Background Tasks
Some work keeps running after a tool returns: a long or \`background: true\` command, a background agent, a project call with \`wait: false\`, an agent you tagged, a card you watch. Those tools return \`{ task_id, status: "running", output_file }\`.
- To block on it, call \`wait({ task_ids: [...] })\`. Pass \`until\` (a regex) to return as soon as its output matches, e.g. a server's "ready" line or a card's "Done".
- Otherwise end your turn. When a task finishes you get a \`[Task update]\` message with its result, and you continue from there.
- Read \`output_file\` for full output, \`task_list\` to see what is running, \`task_cancel\` to stop one you started.
- Start long commands with \`background: true\`, not \`&\`, \`nohup\` or a redirect to your own log: a command that detaches itself is refused, because its task would end at once and lose track of the job.
- Do not poll with sleep or repeated status checks, and do not start the same work again while its task is running.`
