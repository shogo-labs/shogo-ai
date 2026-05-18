import { useEffect, useMemo, useState } from "react";
import {
  Database,
  RefreshCw,
  AlertTriangle,
  Table as TableIcon,
} from "lucide-react-native";

/**
 * Read-only SQLite database viewer. Used by EditorGroupView when a tab's
 * language is "sqlite". The URL points at the raw .db bytes — either a
 * blob: URL (local workspaces, via File System Access) or an http(s):
 * URL (agent workspaces, via the runtime's download endpoint).
 *
 * Implementation notes:
 *  - sql.js is loaded lazily from CDN to avoid pulling a multi-megabyte
 *    wasm bundle into the IDE for users who never open a database.
 *  - Everything runs client-side; we never write back to the file.
 *  - For very large tables we paginate at PAGE_SIZE rows; users can step
 *    through pages without re-opening the database.
 */
const SQL_JS_VERSION = "1.10.3";
const SQL_JS_JS = `https://cdnjs.cloudflare.com/ajax/libs/sql.js/${SQL_JS_VERSION}/sql-wasm.js`;
const SQL_JS_WASM = `https://cdnjs.cloudflare.com/ajax/libs/sql.js/${SQL_JS_VERSION}/sql-wasm.wasm`;
const PAGE_SIZE = 100;

type SqlJsStatic = {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
};
type SqlJsDatabase = {
  exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>;
  close: () => void;
};

declare global {
  interface Window {
    initSqlJs?: (config: { locateFile: (f: string) => string }) => Promise<SqlJsStatic>;
  }
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

function loadSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsPromise) return sqlJsPromise;
  sqlJsPromise = (async () => {
    if (!window.initSqlJs) {
      await new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>(
          `script[data-sql-js="${SQL_JS_VERSION}"]`,
        );
        if (existing) {
          existing.addEventListener("load", () => resolve(), { once: true });
          existing.addEventListener("error", () => reject(new Error("sql.js load failed")), { once: true });
          return;
        }
        const s = document.createElement("script");
        s.src = SQL_JS_JS;
        s.async = true;
        s.dataset.sqlJs = SQL_JS_VERSION;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("sql.js load failed"));
        document.head.appendChild(s);
      });
    }
    if (!window.initSqlJs) throw new Error("sql.js failed to register");
    return window.initSqlJs({ locateFile: () => SQL_JS_WASM });
  })();
  return sqlJsPromise;
}

type TableInfo = { name: string; rowCount: number };

export function SqlitePreview({
  url,
  name,
  path: _path,
}: {
  url: string;
  name: string;
  path: string;
}) {
  const [db, setDb] = useState<SqlJsDatabase | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let openedDb: SqlJsDatabase | null = null;

    (async () => {
      setLoading(true);
      setError(null);
      setTables([]);
      setActiveTable(null);
      setPage(0);
      try {
        const [SQL, bytes] = await Promise.all([
          loadSqlJs(),
          fetch(url).then((r) => {
            if (!r.ok) throw new Error(`Failed to read ${name} (HTTP ${r.status})`);
            return r.arrayBuffer();
          }),
        ]);
        if (cancelled) return;
        openedDb = new SQL.Database(new Uint8Array(bytes));
        // List user tables (skip sqlite_* internal tables).
        const res = openedDb.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        );
        const names = res[0]?.values.map((row) => String(row[0])) ?? [];
        const infos: TableInfo[] = names.map((n) => {
          try {
            const c = openedDb!.exec(`SELECT COUNT(*) FROM "${n.replace(/"/g, '""')}"`);
            return { name: n, rowCount: Number(c[0]?.values[0]?.[0] ?? 0) };
          } catch {
            return { name: n, rowCount: 0 };
          }
        });
        if (cancelled) return;
        setDb(openedDb);
        setTables(infos);
        setActiveTable(infos[0]?.name ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      try {
        openedDb?.close();
      } catch {
        /* ignore */
      }
    };
  }, [url, name, reloadKey]);

  const pageResult = useMemo(() => {
    if (!db || !activeTable) return null;
    try {
      const safe = activeTable.replace(/"/g, '""');
      const offset = page * PAGE_SIZE;
      const rows = db.exec(
        `SELECT * FROM "${safe}" LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      );
      if (rows.length === 0) {
        const cols = db.exec(`PRAGMA table_info("${safe}")`);
        const colNames = cols[0]?.values.map((r) => String(r[1])) ?? [];
        return { columns: colNames, values: [] as unknown[][] };
      }
      return rows[0];
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [db, activeTable, page]);

  const activeInfo = tables.find((t) => t.name === activeTable);
  const totalPages = activeInfo
    ? Math.max(1, Math.ceil(activeInfo.rowCount / PAGE_SIZE))
    : 1;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 items-center justify-between gap-2 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-surface)] px-3 text-[12px] text-[color:var(--ide-muted)]">
        <div className="flex items-center gap-2 min-w-0">
          <Database size={13} className="shrink-0 text-[color:var(--ide-accent-file-icon)]" />
          <span className="truncate text-[color:var(--ide-text)]">{name}</span>
          <span className="shrink-0">
            · {tables.length} table{tables.length === 1 ? "" : "s"} · read-only
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            title="Reload"
            onClick={() => setReloadKey((k) => k + 1)}
            className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-full items-center justify-center text-[13px] text-[color:var(--ide-muted)]">
          Loading {name}…
        </div>
      ) : error ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-[color:var(--ide-error)]">
          <AlertTriangle size={24} />
          <div className="text-[13px]">Could not open {name}</div>
          <div className="text-[12px] text-[color:var(--ide-muted)]">{error}</div>
        </div>
      ) : tables.length === 0 ? (
        <div className="flex h-full items-center justify-center text-[13px] text-[color:var(--ide-muted)]">
          Database has no user tables.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Table list sidebar */}
          <div className="w-48 shrink-0 overflow-y-auto border-r border-[color:var(--ide-border)] bg-[color:var(--ide-surface)] py-1 text-[12px]">
            {tables.map((t) => (
              <button
                key={t.name}
                onClick={() => {
                  setActiveTable(t.name);
                  setPage(0);
                }}
                className={[
                  "flex w-full items-center gap-2 px-3 py-1 text-left",
                  t.name === activeTable
                    ? "bg-[color:var(--ide-hover-subtle)] text-[color:var(--ide-text-strong)]"
                    : "text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover-subtle)]",
                ].join(" ")}
              >
                <TableIcon size={12} className="shrink-0" />
                <span className="truncate">{t.name}</span>
                <span className="ml-auto shrink-0 text-[10px] text-[color:var(--ide-muted)]">
                  {t.rowCount}
                </span>
              </button>
            ))}
          </div>

          {/* Rows panel */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-bg)] px-3 py-1 text-[11px] text-[color:var(--ide-muted)]">
              <span className="truncate">
                {activeTable}
                {activeInfo ? ` · ${activeInfo.rowCount} row${activeInfo.rowCount === 1 ? "" : "s"}` : ""}
              </span>
              <div className="flex items-center gap-2">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="rounded px-1.5 py-0.5 disabled:opacity-40 hover:bg-[color:var(--ide-hover-subtle)]"
                >
                  Prev
                </button>
                <span>
                  Page {page + 1} / {totalPages}
                </span>
                <button
                  disabled={page + 1 >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  className="rounded px-1.5 py-0.5 disabled:opacity-40 hover:bg-[color:var(--ide-hover-subtle)]"
                >
                  Next
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {pageResult && "error" in pageResult ? (
                <div className="p-3 text-[12px] text-[color:var(--ide-error)]">
                  {pageResult.error}
                </div>
              ) : pageResult ? (
                <table className="w-full border-collapse text-[12px]">
                  <thead className="sticky top-0 bg-[color:var(--ide-surface)] text-left text-[color:var(--ide-muted)]">
                    <tr>
                      {pageResult.columns.map((c) => (
                        <th
                          key={c}
                          className="border-b border-[color:var(--ide-border)] px-3 py-1 font-medium"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageResult.values.length === 0 ? (
                      <tr>
                        <td
                          colSpan={Math.max(1, pageResult.columns.length)}
                          className="px-3 py-2 text-[color:var(--ide-muted)]"
                        >
                          (no rows)
                        </td>
                      </tr>
                    ) : (
                      pageResult.values.map((row, i) => (
                        <tr key={i} className="hover:bg-[color:var(--ide-hover-subtle)]">
                          {row.map((cell, j) => (
                            <td
                              key={j}
                              className="border-b border-[color:var(--ide-border)] px-3 py-1 align-top font-mono text-[color:var(--ide-text)]"
                            >
                              {renderCell(cell)}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength} bytes>`;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
