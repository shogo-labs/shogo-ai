/**
 * Cross-platform dev:all script.
 *
 * Replaces the bash-only one-liner so it works on Windows (PowerShell)
 * as well as macOS / Linux.
 *
 *  1. Kill any process occupying the API port (best-effort).
 *  2. Run Prisma migrate deploy against the local SQLite DB.
 *  3. Regenerate the Prisma client(s) so any new models added to the
 *     schema since the last `bun install` are visible at runtime.
 *  4. Generate SDK routes/types/stores from the Prisma schema.
 *  5. Build `packages/sdk` so its `dist/` is in sync with `src/` before
 *     the API boots. The API imports `@shogo-ai/sdk` from `dist/index.js`
 *     and a stale dist surfaces as an opaque "Export named 'X' not found"
 *     SyntaxError that crash-loops watch-api. Skip with SHOGO_SKIP_SDK_BUILD=1.
 *  6. Start the API and web dev servers via concurrently.
 */

import { spawn, spawnSync, type Subprocess } from "bun";
import { spawn as nodeSpawn } from "node:child_process";
import { isAbsolute, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const API_PORT = Number(process.env.API_PORT ?? 8002);
const WEB_PORT = 8081;
const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------------------
// 1. Kill whatever is bound to API_PORT
// ---------------------------------------------------------------------------

/**
 * Returns true when the port is currently bound (bind would fail).
 *
 * We deliberately use a real bind probe rather than a TCP connect probe —
 * a zombie listener owned by a dead process refuses connections but still
 * blocks bind(), and a connect-based test would falsely report "free".
 */
async function isPortBound(port: number): Promise<boolean> {
  try {
    const probe = Bun.serve({
      port,
      hostname: "0.0.0.0",
      fetch: () => new Response("probe"),
    });
    probe.stop(true);
    return false;
  } catch {
    return true;
  }
}

/**
 * Best-effort sweep of stale shogo-ai bun.exe processes left behind from
 * previous dev:all runs. We tree-kill anything whose CommandLine references
 * one of our dev scripts, except this process and the bundled desktop bun.
 */
async function sweepStaleShogoBunProcesses(): Promise<void> {
  if (!IS_WIN) return;
  const ps = spawn({
    cmd: [
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress",
    ],
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(ps.stdout).text();
  await ps.exited;

  let procs: Array<{ ProcessId: number; CommandLine?: string; ExecutablePath?: string }> = [];
  try {
    const parsed = JSON.parse(out.trim() || "[]");
    procs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return;
  }

  const ourPid = process.pid;
  const trigger = /shogo-ai|watch-api\.ts|dev-all\.ts|apps[\\/]+api[\\/]+src[\\/]+entry\.ts/i;
  const desktopBundled = /apps[\\/]+desktop[\\/]+resources[\\/]+bun/i;

  for (const p of procs) {
    if (!p?.ProcessId || p.ProcessId === ourPid) continue;
    if (p.ExecutablePath && desktopBundled.test(p.ExecutablePath)) continue;
    if (!p.CommandLine || !trigger.test(p.CommandLine)) continue;
    spawnSync({
      cmd: ["taskkill", "/F", "/T", "/PID", String(p.ProcessId)],
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}

async function killProcessOnPort(port: number) {
  if (!(await isPortBound(port))) return;

  console.log(`[dev:all] Port ${port} is occupied — clearing…`);
  try {
    if (IS_WIN) {
      const netstat = spawn({
        cmd: ["netstat", "-ano"],
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = await new Response(netstat.stdout).text();
      await netstat.exited;

      const pids = new Set<string>();
      for (const line of output.split("\n")) {
        if (line.includes(`:${port}`) && /LISTENING/i.test(line)) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && /^\d+$/.test(pid)) pids.add(pid);
        }
      }
      for (const pid of pids) {
        spawnSync({
          cmd: ["taskkill", "/F", "/T", "/PID", pid],
          stdout: "ignore",
          stderr: "ignore",
        });
      }

      // Belt-and-suspenders: kill orphaned shogo-ai bun.exe trees that may
      // still hold inherited socket handles to this port.
      await sweepStaleShogoBunProcesses();

      // Wait briefly for sockets to drain before reporting status.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!(await isPortBound(port))) return;
        await Bun.sleep(250);
      }

      if (await isPortBound(port)) {
        console.warn(
          `[dev:all] Port ${port} is still bound by a leaked socket from a previously-killed process.\n` +
            `[dev:all] Windows will not release the bind until the kernel reaps the dead-PID's sockets.\n` +
            `[dev:all] Workarounds: 1) close any browser tab pointing at the dev URL (it keeps connections alive), 2) reboot, or 3) override API_PORT=<other> in .env.local for this session.`
        );
      }
    } else {
      const proc = spawn({
        cmd: ["sh", "-c", `lsof -ti:${port} | xargs kill -9 2>/dev/null`],
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
    }
  } catch {
    // Best-effort — if it fails the watcher will handle the conflict.
  }
}

// ---------------------------------------------------------------------------
// 2. Run Prisma migrations for the local SQLite database
//
// Self-heal note: Prisma's migration apply is two operations — execute
// the SQL, then `UPDATE _prisma_migrations SET finished_at = ?`. SQLite
// commits the SQL first, so when `bun dev:all` is interrupted between
// those two steps (Ctrl+C, watch-api crash mid-boot, OS sleep) the
// schema moves forward but the ledger row stays incomplete. Next boot,
// `prisma migrate deploy` re-runs the same SQL and SQLite returns
// `duplicate column name: X` / `table X already exists` (P3018). Left
// unrecovered, that failed row turns every *subsequent* boot into P3009
// ("failed migrations in the target database"), so `dev:all` aborts until
// the user manually `prisma migrate resolve --applied`s every stuck row.
//
// Recovery happens in two layers:
//
//   * migrateDoctor() (Phase 2) runs BEFORE deploy. It finds unfinished
//     ledger rows, confirms via `prisma migrate diff` that the live DB only
//     drifts on the accepted-drift allow-list, verifies each stuck
//     migration's objects are physically present, and marks them applied —
//     healing the common "interrupted boot" case in one shot.
//
//   * The deploy loop (Phase 1) is the backstop: it parses P3018/P3009 out
//     of `migrate deploy`'s output, and for each named migration verifies
//     EVERY object it creates (columns, tables, indexes, and the SQLite
//     table-rebuild idiom) already exists before marking it applied.
//
// Anything we can't positively verify (DROP COLUMN, triggers, views, raw
// DDL, or a stuck migration whose objects are genuinely missing) falls
// through to a loud abort so we never silently paper over real schema drift.
//
// The whole phase also runs inside a SIGINT guard (see runMigratePhase):
// `migrate deploy` is spawned in its own process group so a Ctrl+C aimed at
// `dev:all` can't tear it down mid-write, and the parent defers its own exit
// until the current step finishes.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = "apps/desktop/prisma/migrations";
const PRISMA_CONFIG = "prisma.config.local.ts";
// Matches the `datasource.url` default in prisma.config.local.ts. In
// practice the real path comes from DATABASE_URL (.env.local), which Bun
// auto-loads for `bun dev:all`.
const DEFAULT_DB_FILE = "shogo.db";
const MAX_AUTO_RESOLVE_RETRIES = 10;

/**
 * Resolve the on-disk path of the local SQLite DB exactly the way Prisma
 * does for `prisma.config.local.ts`: prefer `DATABASE_URL` and fall back to
 * the config's `file:./shogo.db` default. Relative `file:` paths resolve
 * against the repo root, where the Prisma config lives.
 *
 * This used to be hardcoded to `shogo.db`. Any developer who set
 * `DATABASE_URL=file:./shogo-local.db` therefore pointed the auto-resolver
 * at the wrong (usually empty) database, so `isMigrationFullyApplied` never
 * found the columns and the recovery silently never fired.
 */
export function resolveLocalDbPath(
  opts: { rootDir?: string; databaseUrl?: string } = {},
): string {
  const rootDir = opts.rootDir ?? ROOT;
  const raw = (
    opts.databaseUrl ??
    process.env.DATABASE_URL ??
    `file:${DEFAULT_DB_FILE}`
  ).trim();
  let p = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
  // Drop any `?connection_limit=…` style suffix defensively.
  const queryIdx = p.indexOf("?");
  if (queryIdx !== -1) p = p.slice(0, queryIdx);
  if (p.length === 0) p = DEFAULT_DB_FILE;
  return isAbsolute(p) ? p : resolve(rootDir, p);
}

/**
 * Run a prisma CLI command in its own process group (POSIX), streaming
 * stdout to the user and capturing stderr so callers can pattern-match
 * known recoverable failure shapes.
 *
 * `detached` is the load-bearing detail: a Ctrl+C in the `dev:all` terminal
 * is delivered to the foreground process group. Putting prisma in its OWN
 * group means the signal can't kill it between "execute migration SQL" and
 * "write _prisma_migrations.finished_at" — the exact race that creates the
 * ledger drift this module exists to recover from.
 */
function runPrismaDetached(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = nodeSpawn(
      "bun",
      ["x", "prisma", ...args, "--config", PRISMA_CONFIG],
      {
        cwd: ROOT,
        detached: process.platform !== "win32",
        stdio: ["ignore", "inherit", "pipe"],
        env: { ...process.env },
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // Mirror in real time so the user sees errors as they happen.
      process.stderr.write(text);
    });
    child.on("error", (err) => {
      process.stderr.write(`[dev:all] failed to spawn prisma: ${String(err)}\n`);
      resolvePromise({ code: 1, stderr });
    });
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stderr }));
  });
}

async function runMigrateDeploy(): Promise<{ code: number; stderr: string }> {
  return runPrismaDetached(["migrate", "deploy"]);
}

/**
 * Run a prisma command capturing BOTH stdout and stderr (used for
 * `migrate diff`, whose human-readable summary goes to stdout). Not
 * detached — diff is read-only and never writes the ledger.
 */
function runPrismaCapture(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = nodeSpawn(
      "bun",
      ["x", "prisma", ...args, "--config", PRISMA_CONFIG],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        // `migrate diff --from-migrations` replays the SQLite migration
        // history into a shadow DB; SHOGO_LOCAL_MODE keeps the config on the
        // SQLite track (mirrors check-desktop-schema-drift.ts).
        env: { ...process.env, SHOGO_LOCAL_MODE: "true" },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) =>
      resolvePromise({ code: 1, stdout, stderr: stderr + String(err) }),
    );
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

interface RecoverableFailure {
  migrationName: string;
  duplicateColumn: string;
}

/**
 * Pull the migration name + duplicate column out of the P3018 error.
 * Returns null when the error is any other shape (real schema drift,
 * Prisma engine crash, datasource error, etc.) so we abort instead.
 */
export function parseDuplicateColumnFailure(stderr: string): RecoverableFailure | null {
  const isP3018 = stderr.includes("Error: P3018");
  if (!isP3018) return null;
  const nameMatch = stderr.match(/Migration name:\s+(\S+)/);
  const colMatch = stderr.match(/duplicate column name:\s+(\S+)/);
  if (!nameMatch || !colMatch) return null;
  return {
    migrationName: nameMatch[1]!,
    duplicateColumn: colMatch[1]!,
  };
}

/**
 * Identify which migration(s) `prisma migrate deploy` choked on, for both
 * recoverable shapes:
 *
 *   * P3018 — a migration failed *while applying* because its SQL re-ran
 *     against a DB that already has the objects (`duplicate column name` or
 *     `table … already exists`). The error names a single migration.
 *   * P3009 — one or more migrations are recorded as *failed* in
 *     `_prisma_migrations` from a previous boot, so deploy refuses to start.
 *     A P3018 that isn't recovered decays into P3009 on the next run. The
 *     error lists every failed migration.
 *
 * Returns null for every other shape (NOT NULL / FK violation, engine
 * crash, datasource unreachable, …) so the caller aborts loudly. Whether
 * it's actually safe to mark these applied is decided separately by
 * isMigrationFullyApplied — this only extracts names.
 */
export function parseRecoverableFailure(
  stderr: string,
): { migrationNames: string[] } | null {
  if (stderr.includes("Error: P3018")) {
    const nameMatch = stderr.match(/Migration name:\s+(\S+)/);
    const recoverableCause =
      /duplicate column name:/i.test(stderr) || /already exists/i.test(stderr);
    if (nameMatch && recoverableCause) return { migrationNames: [nameMatch[1]!] };
    return null;
  }
  if (stderr.includes("Error: P3009")) {
    const names = [
      ...stderr.matchAll(/The `([^`]+)` migration started at [^\n]*failed/g),
    ].map((m) => m[1]!);
    if (names.length > 0) return { migrationNames: [...new Set(names)] };
    return null;
  }
  return null;
}

/**
 * Rows in `_prisma_migrations` that Prisma treats as failed: SQL was
 * attempted (`started_at` set) but the row was never finished or rolled
 * back. These are exactly the rows that trip P3009 on the next deploy.
 */
export async function findStuckMigrations(dbPath: string): Promise<string[]> {
  const { existsSync, statSync } = await import("node:fs");
  if (!existsSync(dbPath) || statSync(dbPath).size === 0) return [];
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasLedger = db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'",
      )
      .get();
    if (!hasLedger) return [];
    const rows = db
      .query(
        "SELECT migration_name FROM _prisma_migrations " +
          "WHERE finished_at IS NULL AND rolled_back_at IS NULL " +
          "ORDER BY started_at",
      )
      .all() as Array<{ migration_name: string }>;
    return rows.map((r) => r.migration_name);
  } finally {
    db.close();
  }
}

interface MigrationObjectPlan {
  /** Columns the migration adds (table must end up containing each). */
  columns: Array<{ table: string; column: string }>;
  /** Tables that must exist after the migration runs. */
  tablesPresent: string[];
  /** Rebuild temp tables (`new_*`) that must NOT exist after a finished run. */
  tablesAbsent: string[];
  /** Indexes that must exist after the migration runs. */
  indexesPresent: string[];
  /** True if the migration also runs seed/backfill data statements. */
  hasDataStatements: boolean;
}

/**
 * Model the *net* schema objects a migration.sql produces, or return null if
 * it contains a statement we can't safely verify (so the caller fails
 * closed). Recognises ADD COLUMN, CREATE TABLE, CREATE [UNIQUE] INDEX, the
 * SQLite "table rebuild" idiom (CREATE `new_X` → copy → DROP `X` → RENAME
 * `new_X`→`X`), PRAGMA toggles, and data statements (INSERT/UPDATE/DELETE).
 *
 * Standalone DROP TABLE (not part of a rebuild), DROP COLUMN, RENAME COLUMN,
 * triggers, views, and anything else return null.
 */
export function planMigrationObjects(sql: string): MigrationObjectPlan | null {
  // Strip line comments so a `-- DROP TABLE foo;` in a comment can't make
  // the check fail closed (or open).
  const stripped = sql.replace(/--[^\n]*\n/g, "\n");
  const stmts = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const reAddColumn = /^ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+"([^"]+)"/i;
  const reCreateTable = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i;
  const reRename = /^ALTER\s+TABLE\s+"([^"]+)"\s+RENAME\s+TO\s+"([^"]+)"/i;
  const reDropTable = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i;
  const reCreateIndex = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i;
  const reDropIndex = /^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i;
  const reInsert = /^INSERT\s+INTO\s+"([^"]+)"/i;
  const reUpdateDelete = /^(UPDATE|DELETE)\s+/i;
  const rePragma = /^PRAGMA\s+/i;

  const columns: Array<{ table: string; column: string }> = [];
  const created = new Set<string>();
  const dropped: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  const indexesCreated = new Set<string>();
  const indexesDropped = new Set<string>();
  let hasDataStatements = false;

  for (const stmt of stmts) {
    let m: RegExpMatchArray | null;
    if ((m = stmt.match(reAddColumn))) {
      columns.push({ table: m[1]!, column: m[2]! });
    } else if ((m = stmt.match(reCreateTable))) {
      created.add(m[1]!);
    } else if ((m = stmt.match(reRename))) {
      renames.push({ from: m[1]!, to: m[2]! });
    } else if ((m = stmt.match(reDropTable))) {
      dropped.push(m[1]!);
    } else if ((m = stmt.match(reCreateIndex))) {
      indexesCreated.add(m[1]!);
    } else if ((m = stmt.match(reDropIndex))) {
      indexesDropped.add(m[1]!);
    } else if (rePragma.test(stmt)) {
      // foreign_keys / defer_foreign_keys toggles in a rebuild — no-op.
    } else if ((m = stmt.match(reInsert))) {
      // `INSERT INTO new_*` is the rebuild row-copy; other inserts are seeds.
      if (!m[1]!.startsWith("new_")) hasDataStatements = true;
    } else if (reUpdateDelete.test(stmt)) {
      hasDataStatements = true;
    } else {
      return null;
    }
  }

  const renameTargets = new Set(renames.map((r) => r.to));
  const renameSources = new Set(renames.map((r) => r.from));

  // A DROP TABLE is only skip-verifiable when the same table is recreated by
  // a rename in this migration (the rebuild idiom). A standalone DROP is a
  // destructive change we won't auto-resolve.
  for (const d of dropped) {
    if (!renameTargets.has(d)) return null;
  }

  const tablesPresent = new Set<string>();
  for (const t of created) {
    if (!renameSources.has(t)) tablesPresent.add(t); // rebuild temps excluded
  }
  for (const t of renameTargets) tablesPresent.add(t);
  for (const c of columns) tablesPresent.add(c.table);

  return {
    columns,
    tablesPresent: [...tablesPresent],
    tablesAbsent: [...renameSources],
    indexesPresent: [...indexesCreated].filter((i) => !indexesDropped.has(i)),
    hasDataStatements,
  };
}

/**
 * Verify a failed/unfinished migration's effects are ALREADY physically
 * present in the live DB, so it's safe to mark applied without re-running
 * its SQL. Returns true iff every object the migration produces — columns,
 * tables, indexes, and the net result of any SQLite table-rebuild — exists.
 *
 * Fails closed (returns false) for anything planMigrationObjects can't model
 * (DROP COLUMN, triggers, standalone DROP TABLE, …) or any object that isn't
 * actually present, so we never silently paper over real schema drift. Data
 * statements (seeds/backfills) are NOT verified — marking applied skips them,
 * exactly as a hand-run `prisma migrate resolve --applied` would.
 */
export async function isMigrationFullyApplied(
  migrationName: string,
  opts: { rootDir?: string; dbPath?: string; migrationsDir?: string } = {},
): Promise<boolean> {
  const { resolve } = await import("node:path");
  const { readFileSync, existsSync } = await import("node:fs");

  const rootDir = opts.rootDir ?? ROOT;
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const dbPath = opts.dbPath ?? resolveLocalDbPath({ rootDir });

  const sqlPath = resolve(rootDir, migrationsDir, migrationName, "migration.sql");
  if (!existsSync(sqlPath)) return false;
  const sql = readFileSync(sqlPath, "utf8");

  const plan = planMigrationObjects(sql);
  if (!plan) {
    console.log(
      `[dev:all] auto-resolve: ${migrationName} contains a statement we can't ` +
        `safely verify (DROP COLUMN, trigger, standalone DROP TABLE, …) — ` +
        `falling through to abort.`,
    );
    return false;
  }

  // Validate identifier shape before interpolating any name into a PRAGMA
  // (bound params aren't allowed there) — defence in depth against a
  // malformed migration.sql.
  const safeIdent = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const idents = [
    ...plan.columns.flatMap((c) => [c.table, c.column]),
    ...plan.tablesPresent,
    ...plan.tablesAbsent,
    ...plan.indexesPresent,
  ];
  for (const id of idents) {
    if (!safeIdent.test(id)) {
      console.log(
        `[dev:all] auto-resolve: ${migrationName} references a non-identifier-shaped ` +
          `name (${id}) — falling through to abort.`,
      );
      return false;
    }
  }

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const objectExists = (type: "table" | "index", name: string): boolean =>
      db
        .query(`SELECT 1 FROM sqlite_master WHERE type=? AND name=?`)
        .get(type, name) != null;

    for (const t of plan.tablesPresent) {
      if (!objectExists("table", t)) {
        console.log(
          `[dev:all] auto-resolve: ${migrationName} expects table ${t} but it is ` +
            `NOT present — re-running the migration is required.`,
        );
        return false;
      }
    }
    for (const t of plan.tablesAbsent) {
      if (objectExists("table", t)) {
        console.log(
          `[dev:all] auto-resolve: ${migrationName} left rebuild temp table ${t} ` +
            `behind — the table rebuild did not finish; re-running is required.`,
        );
        return false;
      }
    }
    for (const { table, column } of plan.columns) {
      const cols = db.query(`PRAGMA table_info('${table}')`).all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === column)) {
        console.log(
          `[dev:all] auto-resolve: ${migrationName} would add ${table}.${column} ` +
            `but it is NOT yet present — re-running the migration is required.`,
        );
        return false;
      }
    }
    for (const i of plan.indexesPresent) {
      if (!objectExists("index", i)) {
        console.log(
          `[dev:all] auto-resolve: ${migrationName} expects index ${i} but it is ` +
            `NOT present — re-running the migration is required.`,
        );
        return false;
      }
    }
    if (plan.hasDataStatements) {
      console.log(
        `[dev:all] auto-resolve: ${migrationName} — all schema objects present; ` +
          `its seed/backfill data statements are NOT re-run (this matches ` +
          `\`prisma migrate resolve --applied\` semantics).`,
      );
    }
    return true;
  } finally {
    db.close();
  }
}

async function markMigrationApplied(migrationName: string): Promise<boolean> {
  console.log(
    `[dev:all] auto-resolve: marking ${migrationName} as applied (ledger drift recovery)…`,
  );
  const proc = spawn({
    cmd: [
      "bun",
      "x",
      "prisma",
      "migrate",
      "resolve",
      "--applied",
      migrationName,
      "--config",
      PRISMA_CONFIG,
    ],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await proc.exited;
  return code === 0;
}

/**
 * Phase-2 safety gate. Compare the live DB against what the full migration
 * history *should* produce. The desktop SQLite track carries known,
 * intentional drift (ACCEPTED_DRIFT in check-desktop-schema-drift.ts), so we
 * don't require an empty diff — only that every drifting table is on that
 * allow-list. Any *unexpected* drift means something deeper is wrong and we
 * must NOT auto-heal the ledger.
 */
async function liveDbDriftIsAllowlistedOnly(): Promise<boolean> {
  const { ACCEPTED_DRIFT, parseDrift } = await import(
    "./check-desktop-schema-drift"
  );
  const { code, stdout, stderr } = await runPrismaCapture([
    "migrate",
    "diff",
    "--from-migrations",
    MIGRATIONS_DIR,
    "--to-config-datasource",
  ]);
  if (code !== 0) {
    console.warn(
      `[dev:all] migrate doctor: \`migrate diff\` exited ${code}; skipping the ` +
        `auto-resolve safety gate and leaving the ledger to \`migrate deploy\`.` +
        (stderr ? `\n${stderr}` : ""),
    );
    return false;
  }
  const drift = parseDrift(stdout);
  const unexpected = drift.filter((d) => !(d.table in ACCEPTED_DRIFT));
  if (unexpected.length > 0) {
    console.warn(
      `[dev:all] migrate doctor: ${unexpected.length} table(s) drift outside the ` +
        `accepted-drift allow-list (${unexpected
          .map((d) => d.table)
          .join(", ")}). Not auto-resolving — letting \`migrate deploy\` ` +
        `surface this loudly.`,
    );
    return false;
  }
  return true;
}

/**
 * Phase 2: reconcile ledger drift BEFORE `migrate deploy` runs, so the
 * common "schema is ahead of the ledger after an interrupted boot" case
 * heals in one shot instead of surfacing as P3009/P3018.
 */
export async function migrateDoctor(): Promise<void> {
  const dbPath = resolveLocalDbPath();
  const stuck = await findStuckMigrations(dbPath);
  if (stuck.length === 0) return;

  console.log(
    `[dev:all] migrate doctor: ${stuck.length} unfinished migration ledger ` +
      `row(s) detected (${stuck.join(", ")}). Verifying against the live DB…`,
  );

  if (!(await liveDbDriftIsAllowlistedOnly())) return;

  for (const name of stuck) {
    if (!(await isMigrationFullyApplied(name, { dbPath }))) {
      console.warn(
        `[dev:all] migrate doctor: ${name} is NOT fully applied in the DB — ` +
          `leaving it for \`migrate deploy\` to run/repair.`,
      );
      continue;
    }
    if (!(await markMigrationApplied(name))) {
      console.warn(`[dev:all] migrate doctor: failed to mark ${name} as applied.`);
    }
  }
}

function abortMigrate(code: number, msg: string): never {
  console.error(`[dev:all] ${msg}`);
  process.exit(code || 1);
}

export async function migrate() {
  console.log("[dev:all] Running SQLite migrations…");

  // Phase 2: heal known ledger drift before deploy even tries.
  await migrateDoctor();

  // Phase 1: deploy, with a bounded recovery loop as a backstop for any
  // drift the doctor couldn't see (e.g. a genuinely-pending migration whose
  // columns already exist, so it isn't yet a ledger row).
  for (let attempt = 0; attempt <= MAX_AUTO_RESOLVE_RETRIES; attempt++) {
    const { code, stderr } = await runMigrateDeploy();
    if (code === 0) {
      console.log("[dev:all] Migrations applied.");
      return;
    }

    const failure = parseRecoverableFailure(stderr);
    if (!failure) {
      abortMigrate(code, "Migration failed — aborting.");
    }

    if (attempt === MAX_AUTO_RESOLVE_RETRIES) {
      abortMigrate(
        code,
        `auto-resolve gave up after ${MAX_AUTO_RESOLVE_RETRIES} recoveries — ` +
          `aborting. Run \`bun x prisma migrate status --config ${PRISMA_CONFIG}\` ` +
          `to inspect the ledger manually.`,
      );
    }

    console.log(
      `[dev:all] Detected recoverable migration failure on ` +
        `${failure.migrationNames.join(", ")}; verifying against the live DB…`,
    );

    for (const name of failure.migrationNames) {
      if (!(await isMigrationFullyApplied(name))) {
        abortMigrate(
          code,
          `${name} is genuinely not applied (its objects are missing) — ` +
            `re-running it is required but its SQL fails. This is real schema ` +
            `drift, not ledger drift. Aborting; inspect with ` +
            `\`bun x prisma migrate status --config ${PRISMA_CONFIG}\`.`,
        );
      }
      if (!(await markMigrationApplied(name))) {
        abortMigrate(code, `failed to mark ${name} as applied — aborting.`);
      }
    }
    // Loop back and retry `migrate deploy` — the next iteration either
    // succeeds outright or surfaces the next stuck migration in the chain
    // (recovered up to MAX_AUTO_RESOLVE_RETRIES times before giving up).
  }
}

/**
 * Run the migration phase under a SIGINT guard. `migrate deploy` is already
 * spawned in its own process group (see runPrismaDetached) so a Ctrl+C can't
 * kill prisma mid-write; here we also stop the *parent* from tearing down
 * until the current step finishes, then exit cleanly. A second Ctrl+C forces
 * an immediate exit.
 */
async function runMigratePhase(): Promise<void> {
  let interruptCount = 0;
  let interruptRequested = false;
  const onSigint = () => {
    interruptCount++;
    if (interruptCount >= 2) {
      console.error(
        "\n[dev:all] Force-exiting mid-migration — the ledger may need recovery " +
          "on next boot (it will self-heal).",
      );
      process.exit(130);
    }
    interruptRequested = true;
    console.error(
      "\n[dev:all] Ctrl+C during migrations — finishing the current step first " +
        "(interrupting now is what corrupts the ledger). Press Ctrl+C again to force.",
    );
  };
  process.on("SIGINT", onSigint);
  try {
    await migrate();
  } finally {
    process.off("SIGINT", onSigint);
  }
  if (interruptRequested) {
    console.error(
      "[dev:all] Exiting after deferred Ctrl+C (migrations completed safely).",
    );
    process.exit(130);
  }
}

// ---------------------------------------------------------------------------
// 3. Regenerate Prisma client(s)
//
// The SDK route generator also tries to run `prisma generate` internally,
// but on Windows that step has historically failed silently (e.g. when
// the shell-resolution bug in shared-runtime's platform-pkg leaks through).
// Running our own copy here first means the API always boots against an
// up-to-date `apps/api/src/generated/prisma-{pg,sqlite}` client — without
// it, adding a new model to `prisma/schema.prisma` would crash the API at
// runtime with `TypeError: undefined is not an object` until the dev
// remembered to re-run `bun install` or `bun run db:generate:all`.
// ---------------------------------------------------------------------------

async function generatePrismaClients() {
  console.log("[dev:all] Regenerating Prisma client(s)…");
  const proc = spawn({
    cmd: ["bun", "scripts/db-generate-all.ts"],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("[dev:all] Prisma client generation failed — aborting.");
    process.exit(code);
  }
  console.log("[dev:all] Prisma client(s) regenerated.");
}

// ---------------------------------------------------------------------------
// 4. Generate SDK routes / types / stores from the Prisma schema
// ---------------------------------------------------------------------------

async function generateRoutes() {
  console.log("[dev:all] Generating SDK routes…");
  // `--conditions=development` activates the `"development"` export
  // condition declared by each `@shogo-ai/*` workspace package, so Bun
  // resolves `@shogo-ai/cli/pkg`, `@shogo-ai/db`, etc. to their in-tree
  // `src/*.ts` files instead of the `dist/` build (which isn't produced
  // until `bun run build:packages`). Without this, a fresh clone hits
  // `Cannot find module '@shogo-ai/cli/pkg'` here. Mirrors the
  // `generate:routes` script in the root `package.json`.
  const proc = spawn({
    cmd: ["bun", "--conditions=development", "run", "packages/sdk/bin/shogo.ts", "generate"],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("[dev:all] Route generation failed — aborting.");
    process.exit(code);
  }
  console.log("[dev:all] Routes generated.");
}

// ---------------------------------------------------------------------------
// 5. Build packages/sdk so dist/ matches src/
//
// The agent-runtime spawn in `apps/api/src/lib/runtime/manager.ts` runs
// `bun run packages/agent-runtime/src/server.ts` WITHOUT
// `--conditions=development`, so Bun resolves `@shogo-ai/sdk/*` subpath
// imports (`microcompact`, `pi-adapter`, `model-router`, `hooks`,
// `voice`, `tool-orchestration`, …) via the package's default `import`
// condition, which points at `packages/sdk/dist/*.js`. That dist must
// exist before the API tries to spawn its first agent, so we build it
// here as part of `dev:all`'s startup.
//
// SHARP EDGE: tsup's DTS pass walks the workspace's "external"
// `@shogo-ai/{core,agent,db,…}/*` imports and demands each upstream
// package's `dist/*.d.ts` exist. On a truly-fresh checkout, run
// `bun run build:packages` first (the root `package.json` defines the
// correct topological order) — then `dev:all` will incrementally
// rebuild the SDK from there.
//
// `SHOGO_SKIP_SDK_BUILD=1` is the opt-out for devs who know their
// `packages/sdk/dist/` is already current and want a faster `dev:all`
// cold start.
// ---------------------------------------------------------------------------

async function buildSdk() {
  if (process.env.SHOGO_SKIP_SDK_BUILD === "1") {
    console.log("[dev:all] SHOGO_SKIP_SDK_BUILD=1 — skipping SDK build.");
    return;
  }
  console.log("[dev:all] Building packages/sdk…");
  const proc = spawn({
    cmd: ["bun", "run", "--cwd", "packages/sdk", "build"],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("[dev:all] SDK build failed — aborting.");
    process.exit(code);
  }
  console.log("[dev:all] SDK built.");
}

// ---------------------------------------------------------------------------
// 6. Start API + web dev servers
// ---------------------------------------------------------------------------

async function startDevServers() {
  console.log("[dev:all] Starting API and web dev servers…");
  const proc = spawn({
    cmd: [
      "bun",
      "x",
      "concurrently",
      "--kill-others",
      "-n",
      "api,web",
      "-c",
      "green,magenta",
      "bun run api:dev",
      "bun run web:dev",
    ],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  // On Windows, .kill() does TerminateProcess on the immediate child only —
  // its grandchildren (the actual API/web servers) become orphans and leak
  // listening sockets. Tree-kill instead so the whole subtree dies together.
  const cleanup = () => {
    if (IS_WIN && typeof proc.pid === "number") {
      try {
        spawnSync({
          cmd: ["taskkill", "/F", "/T", "/PID", String(proc.pid)],
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {
        proc.kill();
      }
    } else {
      proc.kill();
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const code = await proc.exited;
  process.exit(code ?? 0);
}

// ---------------------------------------------------------------------------
// Main
//
// Gated by `import.meta.main` so `scripts/__tests__/dev-all.test.ts` can
// import this file to exercise the migrate-recovery helpers without the
// import-time side effects (port-kill, prisma generate, dev server boot).
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await Promise.all([killProcessOnPort(API_PORT), killProcessOnPort(WEB_PORT)]);
  await runMigratePhase();
  await generatePrismaClients();
  await generateRoutes();
  await buildSdk();
  await startDevServers();
}
