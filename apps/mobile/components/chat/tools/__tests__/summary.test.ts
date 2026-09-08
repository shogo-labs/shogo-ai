// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the tool-summary helper that powers the minimal text-only
 * tool rows in the chat thread.
 */
import { describe, expect, test } from "bun:test"
import { getToolSummary, parseShellCommand, sepLabel } from "../summary"

describe("getToolSummary — built-in tools", () => {
  test("read_file returns Read + basename", () => {
    expect(getToolSummary("read_file", { path: "/Users/me/proj/package.json" })).toEqual({
      verb: "Read",
      target: "package.json",
    })
    expect(getToolSummary("Read", { file_path: "/a/b/c.ts" })).toEqual({
      verb: "Read",
      target: "c.ts",
    })
  })

  test("Delete returns Delete + basename", () => {
    expect(getToolSummary("Delete", { file_path: "/tmp/foo.txt" })).toEqual({
      verb: "Delete",
      target: "foo.txt",
    })
  })

  test("Grep returns Search for + truncated pattern", () => {
    expect(getToolSummary("Grep", { pattern: "useShogoVoice" })).toEqual({
      verb: "Search for",
      target: "useShogoVoice",
    })
    const long = "a".repeat(50)
    const summary = getToolSummary("Grep", { pattern: long })
    expect(summary.verb).toBe("Search for")
    expect(summary.target?.length).toBeLessThanOrEqual(30)
    expect(summary.target?.endsWith("…")).toBe(true)
  })

  test("Glob returns Find files matching + pattern", () => {
    expect(getToolSummary("Glob", { glob_pattern: "**/*.ts" })).toEqual({
      verb: "Find files matching",
      target: "**/*.ts",
    })
  })

  test("read_lints with paths returns basename target", () => {
    expect(getToolSummary("read_lints", { paths: ["a/b/c.ts"] })).toEqual({
      verb: "Read lints",
      target: "c.ts",
    })
  })

  test("read_lints with no args returns no target", () => {
    expect(getToolSummary("read_lints", {})).toEqual({ verb: "Read lints" })
    expect(getToolSummary("ReadLints")).toEqual({ verb: "Read lints" })
  })

  test("WebSearch returns Search the web for + term", () => {
    expect(getToolSummary("WebSearch", { search_term: "foo" })).toEqual({
      verb: "Search the web for",
      target: "foo",
    })
  })

  test("WebFetch returns Fetch + URL host", () => {
    expect(getToolSummary("WebFetch", { url: "https://example.com/x/y" })).toEqual({
      verb: "Fetch",
      target: "example.com",
    })
  })
})

describe("getToolSummary — exec_wait", () => {
  test("default (no timeout_ms) uses the 30s runtime default", () => {
    expect(getToolSummary("exec_wait", { run_id: "abc" })).toEqual({
      verb: "Waiting for",
      target: "30 seconds",
    })
  })

  test("timeout_ms under a minute renders as seconds", () => {
    expect(getToolSummary("exec_wait", { run_id: "abc", timeout_ms: 5000 })).toEqual({
      verb: "Waiting for",
      target: "5 seconds",
    })
  })

  test("singular second when timeout_ms is 1000", () => {
    expect(getToolSummary("exec_wait", { run_id: "abc", timeout_ms: 1000 })).toEqual({
      verb: "Waiting for",
      target: "1 second",
    })
  })

  test("60000 ms renders as 1 minute (singular)", () => {
    expect(getToolSummary("exec_wait", { run_id: "abc", timeout_ms: 60_000 })).toEqual({
      verb: "Waiting for",
      target: "1 minute",
    })
  })

  test("multi-minute durations render as minutes", () => {
    expect(getToolSummary("exec_wait", { run_id: "abc", timeout_ms: 180_000 })).toEqual({
      verb: "Waiting for",
      target: "3 minutes",
    })
  })

  test("3_600_000 ms renders as 1 hour (singular)", () => {
    expect(getToolSummary("exec_wait", { run_id: "abc", timeout_ms: 3_600_000 })).toEqual({
      verb: "Waiting for",
      target: "1 hour",
    })
  })

  test("multi-hour durations render as hours", () => {
    expect(getToolSummary("exec_wait", { run_id: "abc", timeout_ms: 7_200_000 })).toEqual({
      verb: "Waiting for",
      target: "2 hours",
    })
  })

  test("verb flips to past tense once the wait resolves (success)", () => {
    expect(getToolSummary("exec_wait", { run_id: "abc" }, "success")).toEqual({
      verb: "Waited for",
      target: "30 seconds",
    })
  })

  test("verb flips to past tense on error too", () => {
    expect(getToolSummary("exec_wait", { run_id: "abc", timeout_ms: 5000 }, "error")).toEqual({
      verb: "Waited for",
      target: "5 seconds",
    })
  })

  test("streaming state keeps present-tense verb", () => {
    expect(getToolSummary("exec_wait", { run_id: "abc" }, "streaming")).toEqual({
      verb: "Waiting for",
      target: "30 seconds",
    })
  })
})

describe("getToolSummary — Bash/exec dispatch", () => {
  test("Bash with command defers to parseShellCommand", () => {
    expect(getToolSummary("Bash", { command: "cat /a/b/package.json" })).toEqual({
      verb: "Read",
      target: "package.json",
    })
  })

  test("exec with command defers to parseShellCommand", () => {
    expect(getToolSummary("exec", { command: "ls" })).toEqual({ verb: "List" })
  })

  test("Bash with no command falls back to Run", () => {
    expect(getToolSummary("Bash", {})).toEqual({ verb: "Run" })
  })
})

describe("parseShellCommand — file readers", () => {
  test("cat resolves to Read + basename", () => {
    expect(parseShellCommand("cat /a/b/package.json")).toEqual({
      verb: "Read",
      target: "package.json",
    })
  })

  test("head/tail/less/more all resolve to Read", () => {
    expect(parseShellCommand("head -n 20 foo.txt").verb).toBe("Read")
    expect(parseShellCommand("tail -f log.txt").verb).toBe("Read")
    expect(parseShellCommand("less foo.txt").verb).toBe("Read")
    expect(parseShellCommand("more foo.txt").verb).toBe("Read")
  })
})

describe("parseShellCommand — navigation", () => {
  test("cd resolves to cd + basename", () => {
    expect(parseShellCommand("cd /Users/foo")).toEqual({ verb: "cd", target: "foo" })
  })

  test("ls with path", () => {
    expect(parseShellCommand("ls /tmp/foo")).toEqual({ verb: "List", target: "foo" })
  })

  test("ls without args", () => {
    expect(parseShellCommand("ls")).toEqual({ verb: "List" })
  })

  test("pwd is bare", () => {
    expect(parseShellCommand("pwd")).toEqual({ verb: "pwd" })
  })
})

describe("parseShellCommand — search", () => {
  test("grep with quoted pattern keeps the pattern", () => {
    expect(parseShellCommand("grep -n 'useShogo' src")).toEqual({
      verb: "Search for",
      target: "useShogo",
    })
  })

  test("rg with pattern", () => {
    expect(parseShellCommand("rg -i 'foo bar' .")).toEqual({
      verb: "Search for",
      target: "foo bar",
    })
  })

  test("find returns first non-flag arg", () => {
    expect(parseShellCommand("find /tmp -name foo")).toEqual({
      verb: "Find in",
      target: "tmp",
    })
  })
})

describe("parseShellCommand — git", () => {
  test("git status", () => {
    expect(parseShellCommand("git status")).toEqual({ verb: "git status" })
  })

  test("git commit -m 'foo'", () => {
    expect(parseShellCommand("git commit -m 'foo'")).toEqual({ verb: "git commit" })
  })

  test("bare git", () => {
    expect(parseShellCommand("git")).toEqual({ verb: "git" })
  })
})

describe("parseShellCommand — package managers", () => {
  test("bun run dev", () => {
    expect(parseShellCommand("bun run dev")).toEqual({ verb: "Run", target: "dev" })
  })

  test("npm install foo", () => {
    expect(parseShellCommand("npm install foo")).toEqual({ verb: "Install", target: "foo" })
  })

  test("pnpm add bar", () => {
    expect(parseShellCommand("pnpm add bar")).toEqual({ verb: "Install", target: "bar" })
  })

  test("npm install (bare)", () => {
    expect(parseShellCommand("npm install")).toEqual({ verb: "Install" })
  })
})

describe("parseShellCommand — runners", () => {
  test("node script.js", () => {
    expect(parseShellCommand("node /a/b/script.js")).toEqual({
      verb: "Run",
      target: "script.js",
    })
  })

  test("python file.py", () => {
    expect(parseShellCommand("python foo.py")).toEqual({ verb: "Run", target: "foo.py" })
  })

  test("python3 with heredoc keeps the runner as the target", () => {
    expect(parseShellCommand("python3 << 'EOF'")).toEqual({
      verb: "Run",
      target: "python3",
    })
  })

  test("node with heredoc keeps the runner as the target", () => {
    expect(parseShellCommand("node << EOF")).toEqual({
      verb: "Run",
      target: "node",
    })
  })

  test("here-string <<< is also skipped", () => {
    expect(parseShellCommand("python3 <<< 'print(1)'")).toEqual({
      verb: "Run",
      target: "python3",
    })
  })
})

describe("parseShellCommand — redirections", () => {
  test("output redirect doesn't leak into the target", () => {
    expect(parseShellCommand("cat foo.txt > out.txt")).toEqual({
      verb: "Read",
      target: "foo.txt",
    })
  })

  test("append redirect doesn't leak into the target", () => {
    expect(parseShellCommand("echo hi >> log.txt")).toEqual({
      verb: "echo",
      target: "hi",
    })
  })

  test("2>&1 redirection token is skipped", () => {
    expect(parseShellCommand("python3 foo.py 2>&1")).toEqual({
      verb: "Run",
      target: "foo.py",
    })
  })
})

describe("parseShellCommand — sleep", () => {
  test("bare numeric arg defaults to seconds", () => {
    expect(parseShellCommand("sleep 5")).toEqual({
      verb: "Waiting for",
      target: "5 seconds",
    })
  })

  test("singular second renders without 's'", () => {
    expect(parseShellCommand("sleep 1")).toEqual({
      verb: "Waiting for",
      target: "1 second",
    })
  })

  test("m suffix renders as minutes", () => {
    expect(parseShellCommand("sleep 2m")).toEqual({
      verb: "Waiting for",
      target: "2 minutes",
    })
  })

  test("h suffix renders as hours", () => {
    expect(parseShellCommand("sleep 1h")).toEqual({
      verb: "Waiting for",
      target: "1 hour",
    })
  })

  test("d suffix collapses into hours via formatDuration", () => {
    expect(parseShellCommand("sleep 1d")).toEqual({
      verb: "Waiting for",
      target: "24 hours",
    })
  })

  test("decimal seconds round to nearest second", () => {
    expect(parseShellCommand("sleep 2.7")).toEqual({
      verb: "Waiting for",
      target: "3 seconds",
    })
  })

  test("multiple intervals are summed (POSIX)", () => {
    expect(parseShellCommand("sleep 1 30s 1m")).toEqual({
      verb: "Waiting for",
      target: "2 minutes",
    })
  })

  test("sleep without args falls back to Run sleep", () => {
    expect(parseShellCommand("sleep")).toEqual({ verb: "Run", target: "sleep" })
  })

  test("sleep with unparseable arg falls back to Run sleep", () => {
    expect(parseShellCommand("sleep forever")).toEqual({ verb: "Run", target: "sleep" })
  })

  test("state='success' flips verb to past tense", () => {
    expect(parseShellCommand("sleep 5", "success")).toEqual({
      verb: "Waited for",
      target: "5 seconds",
    })
  })

  test("state='error' also flips verb to past tense", () => {
    expect(parseShellCommand("sleep 1m", "error")).toEqual({
      verb: "Waited for",
      target: "1 minute",
    })
  })

  test("state='streaming' keeps present-tense verb", () => {
    expect(parseShellCommand("sleep 5", "streaming")).toEqual({
      verb: "Waiting for",
      target: "5 seconds",
    })
  })

  test("past-tense flip cascades through &&-joined chain", () => {
    expect(parseShellCommand("sleep 5 && sleep 10", "success")).toEqual({
      verb: "Waited for",
      target: "5 seconds",
      rest: [{ verb: "Waited for", target: "10 seconds", sep: "&&" }],
    })
  })

  test("getToolSummary exec branch threads state through to sleep", () => {
    expect(getToolSummary("exec", { command: "sleep 5" }, "success")).toEqual({
      verb: "Waited for",
      target: "5 seconds",
    })
  })
})

describe("parseShellCommand — fetch", () => {
  test("curl URL", () => {
    expect(parseShellCommand("curl https://api.example.com/x")).toEqual({
      verb: "Fetch",
      target: "api.example.com",
    })
  })

  test("wget URL", () => {
    expect(parseShellCommand("wget -O - https://example.com")).toEqual({
      verb: "Fetch",
      target: "example.com",
    })
  })
})

describe("parseShellCommand — pipelines", () => {
  test("first segment of pipe wins", () => {
    expect(parseShellCommand("ls | grep foo")).toEqual({ verb: "List" })
  })

  test("; chains echo segments with then", () => {
    expect(parseShellCommand("echo a; echo b")).toEqual({
      verb: "echo",
      target: "a",
      rest: [{ verb: "echo", target: "b", sep: ";" }],
    })
  })

  test("multi-line uses first line", () => {
    expect(parseShellCommand("cd foo\nbun test")).toEqual({ verb: "cd", target: "foo" })
  })

  test("leading cd in a chain is skipped", () => {
    expect(parseShellCommand("cd foo && bun test")).toEqual({ verb: "Run", target: "test" })
  })

  test("multiple leading cds are skipped", () => {
    expect(parseShellCommand("cd foo && cd bar && bun run dev")).toEqual({
      verb: "Run",
      target: "dev",
    })
  })

  test("standalone cd is preserved", () => {
    expect(parseShellCommand("cd /Users/foo")).toEqual({ verb: "cd", target: "foo" })
  })

  test("cd followed by ; is also skipped", () => {
    expect(parseShellCommand("cd foo; ls")).toEqual({ verb: "List" })
  })

  test("all-cd chain falls back to last cd", () => {
    expect(parseShellCommand("cd foo && cd bar")).toEqual({ verb: "cd", target: "bar" })
  })
})

describe("parseShellCommand — chains", () => {
  test("two &&-joined commands produce a rest entry with sep", () => {
    expect(parseShellCommand("bun test && bun lint")).toEqual({
      verb: "Run",
      target: "test",
      rest: [{ verb: "Run", target: "lint", sep: "&&" }],
    })
  })

  test("three &&-joined commands produce two rest entries", () => {
    expect(parseShellCommand("git add . && git commit -m foo && git push")).toEqual({
      verb: "git add",
      rest: [
        { verb: "git commit", sep: "&&" },
        { verb: "git push", sep: "&&" },
      ],
    })
  })

  test("leading cd is skipped, remaining && segments chain", () => {
    expect(parseShellCommand("cd foo && bun test && bun lint")).toEqual({
      verb: "Run",
      target: "test",
      rest: [{ verb: "Run", target: "lint", sep: "&&" }],
    })
  })

  test("mid-chain cd is skipped while still chaining", () => {
    expect(parseShellCommand("bun test && cd foo && bun lint")).toEqual({
      verb: "Run",
      target: "test",
      rest: [{ verb: "Run", target: "lint", sep: "&&" }],
    })
  })

  test("|| chain produces a rest entry with sep ||", () => {
    expect(parseShellCommand("bun test || bun lint")).toEqual({
      verb: "Run",
      target: "test",
      rest: [{ verb: "Run", target: "lint", sep: "||" }],
    })
  })

  test("; chain produces a rest entry with sep ;", () => {
    expect(parseShellCommand("bun test; bun lint")).toEqual({
      verb: "Run",
      target: "test",
      rest: [{ verb: "Run", target: "lint", sep: ";" }],
    })
  })

  test("mixed && / || / ; chains keep their separators", () => {
    expect(parseShellCommand("bun test && bun lint || bun fix; echo done")).toEqual({
      verb: "Run",
      target: "test",
      rest: [
        { verb: "Run", target: "lint", sep: "&&" },
        { verb: "Run", target: "fix", sep: "||" },
        { verb: "echo", target: "done", sep: ";" },
      ],
    })
  })

  test("| terminates the chain", () => {
    const result = parseShellCommand("ls && grep foo | wc -l")
    expect(result).toEqual({
      verb: "List",
      rest: [{ verb: "Search for", target: "foo", sep: "&&" }],
    })
  })

  test("single segment has no rest", () => {
    const result = parseShellCommand("bun test")
    expect(result).toEqual({ verb: "Run", target: "test" })
    expect(result.rest).toBeUndefined()
  })
})

describe("parseShellCommand — fallback", () => {
  test("unknown verb keeps command name", () => {
    expect(parseShellCommand("xyzzy --do-it")).toEqual({ verb: "Run", target: "xyzzy" })
  })

  test("empty command", () => {
    expect(parseShellCommand("")).toEqual({ verb: "Run" })
  })
})

describe("getToolSummary — fallback", () => {
  test("unknown tool falls back to tool name + key arg", () => {
    const summary = getToolSummary("mcp__foo__bar", { name: "baz" })
    expect(summary.verb).toBe("mcp__foo__bar")
    expect(summary.target).toBe("baz")
  })

  test("unknown tool with no useful args", () => {
    expect(getToolSummary("custom_tool")).toEqual({ verb: "custom_tool" })
  })
})

describe("parseShellCommand — quote-aware splitting", () => {
  test("| inside double quotes is part of the regex pattern", () => {
    expect(parseShellCommand('grep -n "a|b" file')).toEqual({
      verb: "Search for",
      target: "a or b",
    })
  })

  test("\\| inside double quotes (BRE) is part of the regex pattern", () => {
    expect(parseShellCommand('grep -n "soul\\|character\\|Soul\\|Character"')).toMatchObject({
      verb: "Search for",
    })
    const result = parseShellCommand('grep -n "soul\\|character\\|Soul\\|Character"')
    expect(result.target?.startsWith("soul or character")).toBe(true)
    expect(result.target?.length).toBeLessThanOrEqual(30)
    expect(result.rest).toBeUndefined()
  })

  test("; inside double quotes is part of the echoed string", () => {
    expect(parseShellCommand('echo "foo;bar"')).toEqual({
      verb: "echo",
      target: "foo;bar",
    })
  })

  test("escaped \\| outside quotes is not a pipe separator", () => {
    const result = parseShellCommand("echo foo \\| bar")
    expect(result.verb).toBe("echo")
    expect(result.rest).toBeUndefined()
  })

  test("regression: top-level pipe still terminates the chain", () => {
    expect(parseShellCommand("ls | grep foo")).toEqual({ verb: "List" })
  })
})

describe("getToolSummary — Grep regex prettify", () => {
  test("alternation with \\| is translated to or", () => {
    expect(getToolSummary("Grep", { pattern: "useShogo\\|useFoo" })).toEqual({
      verb: "Search for",
      target: "useShogo or useFoo",
    })
  })

  test("alternation with bare | is translated to or", () => {
    expect(getToolSummary("Grep", { pattern: "foo|bar" })).toEqual({
      verb: "Search for",
      target: "foo or bar",
    })
  })

  test("leading anchor becomes 'starting with'", () => {
    expect(getToolSummary("Grep", { pattern: "^useShogo" })).toEqual({
      verb: "Search for",
      target: "starting with useShogo",
    })
  })

  test("trailing anchor becomes 'ending with'", () => {
    expect(getToolSummary("Grep", { pattern: "useShogo$" })).toEqual({
      verb: "Search for",
      target: "ending with useShogo",
    })
  })

  test("both anchors become 'exactly'", () => {
    expect(getToolSummary("Grep", { pattern: "^useShogo$" })).toEqual({
      verb: "Search for",
      target: "exactly useShogo",
    })
  })

  test("anchors apply per alternative when combined with alternation", () => {
    const summary = getToolSummary("Grep", { pattern: "^foo\\|bar$" })
    expect(summary.verb).toBe("Search for")
    expect(summary.target?.startsWith("starting with foo or ending w")).toBe(true)
    expect(summary.target?.length).toBeLessThanOrEqual(30)
  })

  test("character class becomes 'any of …'", () => {
    expect(getToolSummary("Grep", { pattern: "[abc]" })).toEqual({
      verb: "Search for",
      target: "any of a, b, or c",
    })
  })

  test("character class with range keeps the range token", () => {
    expect(getToolSummary("Grep", { pattern: "[a-z]" })).toEqual({
      verb: "Search for",
      target: "any of a-z",
    })
  })

  test("negated character class becomes 'anything except …'", () => {
    expect(getToolSummary("Grep", { pattern: "[^abc]" })).toEqual({
      verb: "Search for",
      target: "anything except a, b, or c",
    })
  })

  test("two-item character class skips the Oxford comma", () => {
    expect(getToolSummary("Grep", { pattern: "[ab]" })).toEqual({
      verb: "Search for",
      target: "any of a or b",
    })
  })

  test("character classes are stashed before the alternation split", () => {
    const summary = getToolSummary("Grep", { pattern: "[abc]\\|[def]" })
    expect(summary.verb).toBe("Search for")
    expect(summary.target?.startsWith("any of a, b, or c or any of")).toBe(true)
    expect(summary.target?.length).toBeLessThanOrEqual(30)
  })

  test("anchored character class becomes 'exactly any of …'", () => {
    expect(getToolSummary("Grep", { pattern: "^[abc]$" })).toEqual({
      verb: "Search for",
      target: "exactly any of a, b, or c",
    })
  })

  test("plain identifier with no regex syntax is unchanged", () => {
    expect(getToolSummary("Grep", { pattern: "useShogoVoice" })).toEqual({
      verb: "Search for",
      target: "useShogoVoice",
    })
  })
})

describe("parseShellCommand — hardened fallback (no more 'Run <garbage>')", () => {
  test("leading env assignment is stripped", () => {
    expect(parseShellCommand("FOO=bar bun test")).toEqual({ verb: "Run", target: "test" })
  })

  test("multiple leading env assignments are stripped", () => {
    expect(parseShellCommand("FOO=bar BAZ=qux node script.js")).toEqual({
      verb: "Run",
      target: "script.js",
    })
  })

  test("env assignment with an unrecognized command falls back to 'Run command', not 'Run FOO=bar'", () => {
    expect(parseShellCommand("FOO=bar xyzzy")).toEqual({ verb: "Run", target: "xyzzy" })
  })

  test("bare env assignment with nothing after it falls back to 'Run script'", () => {
    expect(parseShellCommand("FOO=bar")).toEqual({ verb: "Run", target: "script" })
  })

  test("sudo wrapper is stripped", () => {
    expect(parseShellCommand("sudo rm -rf /tmp/foo")).toEqual({ verb: "Remove", target: "foo" })
  })

  test("sudo -u wrapper (flag + value) is stripped", () => {
    expect(parseShellCommand("sudo -u root bun test")).toEqual({ verb: "Run", target: "test" })
  })

  test("time wrapper is stripped", () => {
    expect(parseShellCommand("time bun test")).toEqual({ verb: "Run", target: "test" })
  })

  test("env wrapper is stripped", () => {
    expect(parseShellCommand("env bun test")).toEqual({ verb: "Run", target: "test" })
  })

  test("nohup wrapper is stripped", () => {
    expect(parseShellCommand("nohup bun run dev")).toEqual({ verb: "Run", target: "dev" })
  })

  test("command wrapper is stripped", () => {
    expect(parseShellCommand("command ls /tmp")).toEqual({ verb: "List", target: "tmp" })
  })

  test("nice wrapper is stripped", () => {
    expect(parseShellCommand("nice bun test")).toEqual({ verb: "Run", target: "test" })
  })

  test("nice -n wrapper (flag + value) is stripped", () => {
    expect(parseShellCommand("nice -n 10 bun test")).toEqual({ verb: "Run", target: "test" })
  })

  test("timeout N wrapper is stripped", () => {
    expect(parseShellCommand("timeout 30 bun test")).toEqual({ verb: "Run", target: "test" })
  })

  test("timeout with a combined-form flag before the duration is stripped", () => {
    expect(parseShellCommand("timeout --signal=KILL 30 bun test")).toEqual({ verb: "Run", target: "test" })
  })

  test("chained wrappers all strip (sudo nice -n 10 bun test)", () => {
    expect(parseShellCommand("sudo nice -n 10 bun test")).toEqual({ verb: "Run", target: "test" })
  })

  test("leading subshell paren (glued) is stripped", () => {
    expect(parseShellCommand("(bun test)")).toEqual({ verb: "Run", target: "test)" })
  })

  test("leading subshell paren (own token) is stripped", () => {
    const tokens = parseShellCommand("( bun test )")
    expect(tokens.verb).toBe("Run")
    expect(tokens.target).toBe("test")
  })

  test("bare leading paren with nothing after it falls back to 'Run script'", () => {
    expect(parseShellCommand("(")).toEqual({ verb: "Run", target: "script" })
  })

  test("for loop keyword resolves to 'Run script', not 'Run for'", () => {
    expect(parseShellCommand("for f in *.ts; do echo $f; done")).toEqual({
      verb: "Run",
      target: "script",
    })
  })

  test("while loop keyword resolves to 'Run script'", () => {
    expect(parseShellCommand("while true; do sleep 1; done")).toEqual({
      verb: "Run",
      target: "script",
    })
  })

  test("if keyword resolves to 'Run script'", () => {
    expect(parseShellCommand("if [ -f foo ]; then cat foo; fi")).toEqual({
      verb: "Run",
      target: "script",
    })
  })

  test("case keyword resolves to 'Run script'", () => {
    expect(parseShellCommand("case $x in a) echo a;; esac")).toEqual({
      verb: "Run",
      target: "script",
    })
  })

  test("bare [ test keyword resolves to 'Run script'", () => {
    expect(parseShellCommand("[ -f foo ] && echo yes")).toEqual({
      verb: "Run",
      target: "script",
    })
  })

  test("export with assignment resolves to 'Set <VAR>'", () => {
    expect(parseShellCommand("export PATH=/usr/bin:$PATH")).toEqual({ verb: "Set", target: "PATH" })
  })

  test("export without assignment resolves to 'Set <VAR>'", () => {
    expect(parseShellCommand("export PATH")).toEqual({ verb: "Set", target: "PATH" })
  })

  test("source resolves to 'Source <file>'", () => {
    expect(parseShellCommand("source ./scripts/env.sh")).toEqual({ verb: "Source", target: "env.sh" })
  })

  test(". (dot) resolves to 'Source <file>'", () => {
    expect(parseShellCommand(". ./env.sh")).toEqual({ verb: "Source", target: "env.sh" })
  })

  test("heredoc write via cat resolves to 'Write <file>'", () => {
    expect(parseShellCommand("cat > notes.txt << EOF")).toEqual({ verb: "Write", target: "notes.txt" })
  })

  test("cat with an existing input file before the redirect stays 'Read' (output redirect is incidental)", () => {
    expect(parseShellCommand("cat foo.txt > out.txt")).toEqual({ verb: "Read", target: "foo.txt" })
  })

  test("echo with nothing but a redirect resolves to 'Write <file>'", () => {
    expect(parseShellCommand("echo > notes.txt")).toEqual({ verb: "Write", target: "notes.txt" })
  })

  test("bun with flags before the subcommand skips them (bun --no-env-file test)", () => {
    expect(parseShellCommand("bun --no-env-file test")).toEqual({ verb: "Run", target: "test" })
  })

  test("bunx resolves to 'Run <pkg>'", () => {
    expect(parseShellCommand("bunx tsc --noEmit")).toEqual({ verb: "Run", target: "tsc" })
  })

  test("npx resolves to 'Run <pkg>'", () => {
    expect(parseShellCommand("npx create-react-app my-app")).toEqual({
      verb: "Run",
      target: "create-react-app",
    })
  })

  test("bun x <pkg> (subcommand form) resolves to 'Run <pkg>'", () => {
    expect(parseShellCommand("bun x cowsay hello")).toEqual({ verb: "Run", target: "cowsay" })
  })

  test("git -C <dir> skips the flag+value (git -C /path status)", () => {
    expect(parseShellCommand("git -C /path/to/repo status")).toEqual({ verb: "git status" })
  })

  test("docker compose resolves to 'docker compose <sub>'", () => {
    expect(parseShellCommand("docker compose up -d")).toEqual({ verb: "docker compose up" })
  })

  test("bare docker compose (no sub) resolves without a dangling target", () => {
    expect(parseShellCommand("docker compose")).toEqual({ verb: "docker compose" })
  })

  test("docker (non-compose) resolves to 'docker <sub>'", () => {
    expect(parseShellCommand("docker ps -a")).toEqual({ verb: "docker ps" })
  })

  test("kubectl resolves to 'kubectl <sub>' + target", () => {
    expect(parseShellCommand("kubectl get pods")).toEqual({ verb: "kubectl get", target: "pods" })
  })

  test("make resolves to 'Run <target>'", () => {
    expect(parseShellCommand("make build")).toEqual({ verb: "Run", target: "build" })
  })

  test("bare make falls back to 'Run make'", () => {
    expect(parseShellCommand("make")).toEqual({ verb: "Run", target: "make" })
  })

  test("cargo resolves to 'cargo <sub>'", () => {
    expect(parseShellCommand("cargo build --release")).toEqual({ verb: "cargo build" })
  })

  test("go resolves to 'go <sub>'", () => {
    expect(parseShellCommand("go test ./...")).toEqual({ verb: "go test" })
  })

  test("pytest resolves to 'Run <path>'", () => {
    expect(parseShellCommand("pytest tests/test_foo.py")).toEqual({
      verb: "Run",
      target: "test_foo.py",
    })
  })

  test("bunx tsc --noEmit with no positional target falls back to the tool name", () => {
    expect(parseShellCommand("tsc --noEmit")).toEqual({ verb: "Run", target: "tsc" })
  })

  test("eslint resolves to 'Run <path>'", () => {
    expect(parseShellCommand("eslint src/")).toEqual({ verb: "Run", target: "src" })
  })

  test("prettier with no path falls back to the tool name", () => {
    expect(parseShellCommand("prettier --check .")).toEqual({ verb: "Run", target: "." })
  })

  test("sed -n '1,20p' f resolves to 'Run <file>'", () => {
    expect(parseShellCommand("sed -n '1,20p' foo.txt")).toEqual({ verb: "Run", target: "foo.txt" })
  })

  test("awk resolves to 'Run <file>'", () => {
    expect(parseShellCommand("awk '{print $1}' foo.txt")).toEqual({ verb: "Run", target: "foo.txt" })
  })

  test("wc resolves to 'Count lines in <file>'", () => {
    expect(parseShellCommand("wc -l foo.txt")).toEqual({ verb: "Count lines in", target: "foo.txt" })
  })

  test("diff resolves to 'Diff <file>'", () => {
    expect(parseShellCommand("diff a.txt b.txt")).toEqual({ verb: "Diff", target: "a.txt" })
  })

  test("tree resolves to 'List <dir>'", () => {
    expect(parseShellCommand("tree src")).toEqual({ verb: "List", target: "src" })
  })

  test("chmod resolves to 'Change permissions of <file>'", () => {
    expect(parseShellCommand("chmod 755 script.sh")).toEqual({
      verb: "Change permissions of",
      target: "script.sh",
    })
  })

  test("kill resolves to 'Kill process <pid>'", () => {
    expect(parseShellCommand("kill -9 1234")).toEqual({ verb: "Kill process", target: "1234" })
  })

  test("open resolves to 'Open <target>'", () => {
    expect(parseShellCommand("open /Applications/Foo.app")).toEqual({ verb: "Open", target: "Foo.app" })
  })

  test("which resolves to 'Locate <name>'", () => {
    expect(parseShellCommand("which node")).toEqual({ verb: "Locate", target: "node" })
  })

  test("multi-line script uses the first line (for loop) — still 'Run script'", () => {
    expect(parseShellCommand("for f in *.ts\ndo\n  cat $f\ndone")).toEqual({
      verb: "Run",
      target: "script",
    })
  })

  test("unrecognized command starting with $ falls back to 'Run command'", () => {
    expect(parseShellCommand("$SOME_VAR --flag")).toEqual({ verb: "Run", target: "command" })
  })

  test("a bare flag with no command falls back to 'Run command'", () => {
    expect(parseShellCommand("--verbose")).toEqual({ verb: "Run", target: "command" })
  })
})

describe("sepLabel", () => {
  test("&& maps to 'and'", () => {
    expect(sepLabel("&&")).toBe("and")
  })

  test("|| maps to 'or'", () => {
    expect(sepLabel("||")).toBe("or")
  })

  test("; maps to 'then'", () => {
    expect(sepLabel(";")).toBe("then")
  })

  test("undefined defaults to 'and'", () => {
    expect(sepLabel(undefined)).toBe("and")
  })
})
