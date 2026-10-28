// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Detects shell commands that detach part of themselves (`cmd &`,
 * `nohup cmd > log &`, `setsid -f`, `disown`).
 *
 * Every exec becomes a task, and the task follows the shell it started. A job
 * the shell sends off with `&` keeps running after that shell exits, so the
 * task reports "completed" at once while the real work carries on unseen. The
 * agent then polls with sleep loops or starts the job a second time. `exec`
 * rejects these and points at `background: true`, which keeps the job inside
 * the task: it gets a task_id, an output file, and a completion notification.
 *
 * `cmd1 & cmd2 & wait` is allowed, since the shell waits for its jobs.
 */

export interface Segment {
  words: string[]
  /** Operator that ended the segment (`&`, `&&`, `||`, `;`, `|`, `\n`), or '' at the end. */
  terminator: string
}

export interface DetachCheck {
  detached: boolean
  /** What the command does to detach, for the error message. */
  how?: string
  /** The detached job writes its output to a file of its own. */
  ownLog?: boolean
  /** The same job as a single command to run with `background: true`, when there is one. */
  suggestion?: string
}

function readHeredocDelimiter(command: string, index: number): { delimiter: string; end: number } | null {
  let i = index
  if (command[i] === '-') i += 1
  while (command[i] === ' ' || command[i] === '\t') i += 1
  let delimiter = ''
  while (i < command.length && !/[\s;&|<>()]/.test(command[i]!)) {
    const ch = command[i]!
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1)
      if (close === -1) return null
      delimiter += command.slice(i + 1, close)
      i = close + 1
      continue
    }
    if (ch === '\\') {
      i += 1
      continue
    }
    delimiter += ch
    i += 1
  }
  return delimiter ? { delimiter, end: i } : null
}

/** Splits a command into simple commands at top-level operators, skipping quotes, comments and heredoc bodies. */
export function segmentsOf(command: string): Segment[] {
  const segments: Segment[] = []
  let words: string[] = []
  let word = ''
  const heredocs: string[] = []

  const endWord = () => {
    if (word) words.push(word)
    word = ''
  }
  const endSegment = (terminator: string) => {
    endWord()
    if (words.length > 0) segments.push({ words, terminator })
    words = []
  }

  let i = 0
  while (i < command.length) {
    const ch = command[i]!
    const next = command[i + 1]

    if (ch === '\\') {
      word += next ?? ''
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1)
      const stop = close === -1 ? command.length : close
      word += command.slice(i + 1, stop)
      i = stop + 1
      continue
    }
    if (ch === '#' && !word) {
      while (i < command.length && command[i] !== '\n') i += 1
      continue
    }
    if (ch === '\n') {
      endSegment('\n')
      i += 1
      for (const delimiter of heredocs.splice(0)) {
        while (i < command.length) {
          const lineEnd = command.indexOf('\n', i)
          const line = command.slice(i, lineEnd === -1 ? command.length : lineEnd)
          i = lineEnd === -1 ? command.length : lineEnd + 1
          if (line.replace(/^\t+/, '') === delimiter) break
        }
      }
      continue
    }
    if (ch === '<' && next === '<' && command[i + 2] !== '<') {
      const heredoc = readHeredocDelimiter(command, i + 2)
      if (heredoc) {
        endWord()
        heredocs.push(heredoc.delimiter)
        i = heredoc.end
        continue
      }
    }
    if (ch === '&' && next === '&') {
      endSegment('&&')
      i += 2
      continue
    }
    if (ch === '|' && next === '|') {
      endSegment('||')
      i += 2
      continue
    }
    if (ch === '&') {
      const prev = command[i - 1]
      // `2>&1`, `>&2`, `<&3`, `&>file`, `&>>file` are redirections, not jobs.
      if (prev === '>' || prev === '<' || next === '>') {
        word += ch
        i += 1
        continue
      }
      if (command[i - 1] === '|') {
        i += 1
        continue
      }
      endSegment('&')
      i += 1
      continue
    }
    if (ch === ';' || ch === '|') {
      endSegment(ch)
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      endWord()
      i += 1
      continue
    }
    word += ch
    i += 1
  }
  endSegment('')
  return segments
}

/** The command name of a simple command, past `VAR=value` assignments. */
export function commandName(words: string[]): string | undefined {
  return words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
}

const REDIRECT = /^(\d*>>?|&>>?)$/
const ATTACHED_REDIRECT = /^(\d*>>?|&>>?)([^&>].*)$/

/** Whether the job sends its output to a file of its own (not /dev/null, not another fd). */
function redirectsToFile(words: string[]): boolean {
  return words.some((w, i) => {
    const target = REDIRECT.test(w) ? words[i + 1] : w.match(ATTACHED_REDIRECT)?.[2]
    return !!target && target !== '/dev/null'
  })
}

export function checkSelfDetach(command: string): DetachCheck {
  const segments = segmentsOf(command)

  for (const [index, segment] of segments.entries()) {
    const name = commandName(segment.words)
    if (name === 'disown') return { detached: true, how: '`disown`' }
    if (name === 'setsid' && segment.words.some((w) => w === '-f' || w === '--fork')) {
      return { detached: true, how: '`setsid -f`' }
    }
    if (segment.terminator !== '&') continue

    const waitedOn = segments.slice(index + 1).some((s) => commandName(s.words) === 'wait')
    if (waitedOn) continue

    const how = name === 'nohup' ? '`nohup … &`' : '`&`'
    return {
      detached: true,
      how,
      ownLog: redirectsToFile(segment.words),
      suggestion:
        segments.length === 1 ? command.replace(/\s*&\s*$/, '').replace(/^\s*nohup\s+/, '').trim() : undefined,
    }
  }
  return { detached: false }
}

export function selfDetachRefusal(check: DetachCheck): string {
  const lines = [
    `Not run: this command detaches itself (${check.how}). The task would only follow the launcher, which exits at once, ` +
      'so you would lose track of the job: no completion notice, no exit code, and wait would return immediately.',
  ]
  if (check.suggestion) {
    lines.push(
      `Run it as a background task instead: exec({ command: ${JSON.stringify(check.suggestion)}, background: true }).`,
    )
    if (check.ownLog) {
      lines.push('Its output goes to the task output_file, so drop any redirect that only exists to keep a log.')
    }
  } else {
    lines.push(
      'Split it up: start the long-running part on its own with exec({ command, background: true }) (no `&`, no `nohup`, ' +
        'no redirect to your own log; output goes to the task output_file), then run the rest as separate exec calls. ' +
        'To continue once a server is up, use wait({ task_ids: [id], until: "<ready text>" }).',
    )
  }
  lines.push('Then either wait on the task_id or end your turn; you get a [Task update] when it finishes.')
  return lines.join('\n')
}
