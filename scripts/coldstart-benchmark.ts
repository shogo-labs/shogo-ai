#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * coldstart-benchmark.ts — Phase 0 cold-start baseline harness
 * ============================================================================
 * Aggregates the per-phase cold-start timing the runtime ALREADY emits (via
 * `logTiming`, see packages/shared-runtime/src/server-framework.ts) across MANY
 * assigned runtime pods and reports P50/P95/P99 per phase, bucketed by tech
 * stack. This is the "before-numbers" baseline the Firecracker-snapshot work is
 * gated against (see the Cloud Firecracker snapshots plan, Phase 0).
 *
 * It is the aggregating sibling of scripts/harvest-coldstart-timing.sh (which
 * dumps a single pod). No redeploy needed — it only reads existing logs.
 *
 * Phase markers parsed (emitted by packages/agent-runtime/src/server.ts):
 *   entrypoint (t=0)
 *     -> "Initializing essentials..."
 *     -> "Workspace files ready"
 *     -> "S3 sync initialized"        (source hydrate done)
 *     -> "Workspace deps ready" | "Background deps restore ready"
 *     -> "Essentials complete"
 *     -> "Starting agent gateway..."
 *     -> "Agent gateway started"      (HEADLINE: end-to-end to serving)
 *
 * Tech stack is read inline from "Tech stack seeded: <id>" /
 * "Tech stack setup complete: <id>" so no DB join is required.
 *
 * Usage:
 *   bun run scripts/coldstart-benchmark.ts                     # auto-discover
 *   bun run scripts/coldstart-benchmark.ts --limit 50
 *   bun run scripts/coldstart-benchmark.ts --pods a,b,c
 *   KUBECONTEXT=oke-staging WORKSPACES_NS=shogo-staging-workspaces \
 *     bun run scripts/coldstart-benchmark.ts --out benchmarks
 *
 * Output:
 *   <out>/coldstart-baseline-<ISO>.json   machine-readable percentiles
 *   <out>/coldstart-baseline-<ISO>.md     human-readable report
 *   (also printed to stdout)
 */

import { execFileSync } from "child_process"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"

// ---------------------------------------------------------------------------
// CLI args + config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const getArg = (flag: string): string | undefined => {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] : undefined
}

const CONTEXT = getArg("--context") || process.env.KUBECONTEXT || "oke-staging"
const NAMESPACE =
  getArg("--namespace") || process.env.WORKSPACES_NS || "shogo-staging-workspaces"
const LIMIT = parseInt(getArg("--limit") || "40", 10)
const TAIL = parseInt(getArg("--tail") || "6000", 10)
const OUT_DIR = getArg("--out") || "benchmarks"
const EXPLICIT_PODS = (getArg("--pods") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

// ---------------------------------------------------------------------------
// Phase definitions — ordered boundaries measured as absolute ms-from-entrypoint
// at the first matching log line. `deltaFrom` produces an inter-phase duration.
// ---------------------------------------------------------------------------
interface PhaseDef {
  key: string
  label: string
  /** All substrings that can mark this boundary; first match wins. */
  markers: string[]
  /** If set, also emit a delta metric `<key>` = this.total - <deltaFrom>.total */
  deltaFrom?: string
  headline?: boolean
}

const PHASES: PhaseDef[] = [
  { key: "essentials_start", label: "Initializing essentials", markers: ["Initializing essentials..."] },
  {
    key: "workspace_files",
    label: "Workspace files ready",
    markers: ["Workspace files ready"],
    deltaFrom: "essentials_start",
  },
  {
    key: "s3_init",
    label: "S3 sync initialized (source hydrate)",
    markers: ["S3 sync initialized"],
    deltaFrom: "workspace_files",
  },
  {
    key: "deps_ready",
    label: "Deps ready",
    markers: ["Workspace deps ready", "Background deps restore ready"],
  },
  {
    key: "essentials_complete",
    label: "Essentials complete",
    markers: ["Essentials complete"],
    deltaFrom: "essentials_start",
  },
  {
    key: "gateway_start",
    label: "Starting agent gateway",
    markers: ["Starting agent gateway..."],
  },
  {
    key: "gateway_ready",
    label: "Agent gateway started (end-to-end)",
    markers: ["Agent gateway started"],
    deltaFrom: "essentials_start",
    headline: true,
  },
]

const STACK_MARKERS = ["Tech stack setup complete:", "Tech stack seeded:"]
const UNKNOWN_STACK = "unknown"

// A logTiming line looks like:
//   [agent-runtime] [+12345ms total, +6789ms server] <message>
const TIMING_RE = /\[\+(\d+)ms total, \+\d+ms server\]\s*(.*)$/

// ---------------------------------------------------------------------------
// kubectl helpers
// ---------------------------------------------------------------------------
function kubectl(kargs: string[]): string {
  return execFileSync("kubectl", ["--context", CONTEXT, "-n", NAMESPACE, ...kargs], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function discoverAssignedPods(): string[] {
  const raw = kubectl([
    "get",
    "pods",
    "--field-selector=status.phase=Running",
    "-l",
    "serving.knative.dev/service",
    "--sort-by=.metadata.creationTimestamp",
    "-o",
    "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}",
  ])
  // Newest first, cap the scan window generously (assignment filter drops most).
  return raw.split("\n").map((s) => s.trim()).filter(Boolean).reverse()
}

function appContainer(pod: string): string {
  try {
    const names = kubectl([
      "get",
      "pod",
      pod,
      "-o",
      "jsonpath={range .spec.containers[*]}{.name}{\"\\n\"}{end}",
    ])
      .split("\n")
      .map((s) => s.trim())
      .filter((n) => n && n !== "queue-proxy")
    return names[0] || "user-container"
  } catch {
    return "user-container"
  }
}

function podLogs(pod: string, container: string): string {
  try {
    return kubectl(["logs", pod, "-c", container, `--tail=${TAIL}`])
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// Parse one pod's logs into a sample of {stack, phase totals, deltas}
// ---------------------------------------------------------------------------
interface Sample {
  pod: string
  stack: string
  totals: Record<string, number> // phase key -> ms-from-entrypoint
  deltas: Record<string, number> // delta key -> ms
  assigned: boolean
}

function parsePod(pod: string, logs: string): Sample | null {
  if (!logs) return null
  const totals: Record<string, number> = {}
  let stack = UNKNOWN_STACK

  for (const line of logs.split("\n")) {
    const m = TIMING_RE.exec(line)
    if (!m) {
      // Stack can also appear on non-timing lines; check anyway.
      for (const sm of STACK_MARKERS) {
        const at = line.indexOf(sm)
        if (at !== -1) stack = line.slice(at + sm.length).trim().split(/\s/)[0] || stack
      }
      continue
    }
    const totalMs = parseInt(m[1], 10)
    const msg = m[2]

    for (const sm of STACK_MARKERS) {
      const at = msg.indexOf(sm)
      if (at !== -1) stack = msg.slice(at + sm.length).trim().split(/\s/)[0] || stack
    }

    for (const p of PHASES) {
      if (totals[p.key] !== undefined) continue // first match wins
      if (p.markers.some((mk) => msg.includes(mk))) {
        totals[p.key] = totalMs
        break
      }
    }
  }

  // A pod counts as an assigned cold start only if it reached essentials.
  const assigned = totals.essentials_start !== undefined
  if (!assigned) return null

  const deltas: Record<string, number> = {}
  for (const p of PHASES) {
    if (p.deltaFrom && totals[p.key] !== undefined && totals[p.deltaFrom] !== undefined) {
      deltas[p.key] = totals[p.key] - totals[p.deltaFrom]
    }
  }
  return { pod, stack, totals, deltas, assigned }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
interface Stat {
  count: number
  min: number
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  // Nearest-rank.
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

function summarize(values: number[]): Stat {
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    mean: sorted.length ? Math.round(sum / sorted.length) : NaN,
  }
}

type MetricKind = "total" | "delta"
interface MetricDef {
  key: string
  label: string
  kind: MetricKind
  headline?: boolean
}

function metricDefs(): MetricDef[] {
  const defs: MetricDef[] = []
  for (const p of PHASES) {
    defs.push({ key: p.key, label: `${p.label} (total)`, kind: "total", headline: p.headline })
    if (p.deltaFrom) {
      defs.push({ key: `Δ_${p.key}`, label: `${p.label} (phase Δ)`, kind: "delta" })
    }
  }
  return defs
}

function valueFor(sample: Sample, def: MetricDef): number | undefined {
  if (def.kind === "total") return sample.totals[def.key]
  return sample.deltas[def.key.replace(/^Δ_/, "")]
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function fmt(ms: number): string {
  return Number.isNaN(ms) ? "—" : `${(ms / 1000).toFixed(2)}s`
}

async function main() {
  console.log(`Cold-start baseline — context=${CONTEXT} ns=${NAMESPACE}`)

  // Preflight: reachable cluster.
  try {
    kubectl(["get", "pods", "-o", "name"])
  } catch (err: any) {
    console.error(`! Cannot reach ${CONTEXT}/${NAMESPACE}: ${err.message?.split("\n")[0]}`)
    process.exit(1)
  }

  const candidates = EXPLICIT_PODS.length ? EXPLICIT_PODS : discoverAssignedPods()
  console.log(`Scanning up to ${LIMIT} of ${candidates.length} candidate pods…`)

  const samples: Sample[] = []
  for (const pod of candidates) {
    if (samples.length >= LIMIT) break
    const container = appContainer(pod)
    const logs = podLogs(pod, container)
    const sample = parsePod(pod, logs)
    if (sample) {
      samples.push(sample)
      process.stdout.write(
        `  [${samples.length}/${LIMIT}] ${pod} stack=${sample.stack} → ${fmt(
          sample.totals.gateway_ready ?? NaN,
        )}\n`,
      )
    }
  }

  if (samples.length === 0) {
    console.error("! No assigned cold-start samples found. Widen --limit or check the namespace.")
    process.exit(1)
  }

  const defs = metricDefs()
  const stacks = Array.from(new Set(samples.map((s) => s.stack))).sort()
  const groups: Record<string, Sample[]> = { __all__: samples }
  for (const st of stacks) groups[st] = samples.filter((s) => s.stack === st)

  // Build report structure: { group -> metricKey -> Stat }
  const report: Record<string, Record<string, Stat>> = {}
  for (const [group, gSamples] of Object.entries(groups)) {
    report[group] = {}
    for (const def of defs) {
      const vals = gSamples
        .map((s) => valueFor(s, def))
        .filter((v): v is number => typeof v === "number" && !Number.isNaN(v))
      if (vals.length) report[group][def.key] = summarize(vals)
    }
  }

  const iso = new Date().toISOString().replace(/[:.]/g, "-")
  mkdirSync(OUT_DIR, { recursive: true })
  const jsonPath = join(OUT_DIR, `coldstart-baseline-${iso}.json`)
  const mdPath = join(OUT_DIR, `coldstart-baseline-${iso}.md`)

  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        context: CONTEXT,
        namespace: NAMESPACE,
        sampleCount: samples.length,
        stacks: Object.fromEntries(stacks.map((s) => [s, groups[s].length])),
        metrics: defs,
        report,
        samples: samples.map((s) => ({ pod: s.pod, stack: s.stack, totals: s.totals })),
      },
      null,
      2,
    ),
  )

  // Markdown report.
  const lines: string[] = []
  lines.push(`# Cold-start baseline — ${new Date().toISOString()}`)
  lines.push("")
  lines.push(`- Context: \`${CONTEXT}\`  Namespace: \`${NAMESPACE}\``)
  lines.push(`- Samples: **${samples.length}** assigned cold starts`)
  lines.push(
    `- By stack: ${stacks.map((s) => `\`${s}\`=${groups[s].length}`).join(", ") || "(none tagged)"}`,
  )
  lines.push("")
  const headline = defs.find((d) => d.headline)
  if (headline && report.__all__[headline.key]) {
    const h = report.__all__[headline.key]
    lines.push(
      `**Headline (end-to-end to gateway, all stacks): P50 ${fmt(h.p50)} · P95 ${fmt(
        h.p95,
      )} · P99 ${fmt(h.p99)}**`,
    )
    lines.push("")
  }

  for (const group of ["__all__", ...stacks]) {
    const title = group === "__all__" ? "All stacks" : `Stack: ${group}`
    lines.push(`## ${title} (n=${groups[group].length})`)
    lines.push("")
    lines.push("| Phase metric | P50 | P95 | P99 | min | max | n |")
    lines.push("| --- | --- | --- | --- | --- | --- | --- |")
    for (const def of defs) {
      const s = report[group][def.key]
      if (!s) continue
      lines.push(
        `| ${def.label} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.min)} | ${fmt(
          s.max,
        )} | ${s.count} |`,
      )
    }
    lines.push("")
  }
  writeFileSync(mdPath, lines.join("\n"))

  // Console summary.
  console.log("")
  console.log(lines.join("\n"))
  console.log("")
  console.log(`Wrote ${jsonPath}`)
  console.log(`Wrote ${mdPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
