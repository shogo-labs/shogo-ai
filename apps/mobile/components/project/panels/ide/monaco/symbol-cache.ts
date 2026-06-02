/**
 * symbol-cache.ts — version-aware DocumentSymbol cache (BUG-010).
 *
 * Canvas evidence: "Breadcrumbs symbol picker stale after rename. Symbol
 * cache keyed by URI only. Fix: Invalidate on model.version change."
 *
 * Current state (before this fix): provideDocumentSymbols in lspProviders
 * has NO cache at all — every breadcrumbs/outline hover hits the backend
 * tsserver synchronously. On a 1000-line file this is 50-200 ms per
 * invocation, and Monaco's breadcrumb picker re-invokes it on every
 * keystroke, every cursor move that crosses a symbol boundary, and every
 * dropdown render. The result is a sluggish breadcrumb UX.
 *
 * Naive fix: cache by URI. Symptom: rename a function, breadcrumb still
 * shows the old name until the user reopens the file or types far enough
 * to evict from memory. That's the BUG-010 prescription's "keyed by URI
 * only" hazard.
 *
 * Correct fix (what this module implements): cache keyed by
 *   (uri.toString(), model.getVersionId())
 * Any edit bumps Monaco's monotonic version id; rename creates a new
 * model with version 1 (different URI anyway, but defense in depth).
 * Both invalidate the cache without any explicit clear call.
 *
 * Why a separate pure module:
 *   - LRU + eviction logic deserves unit tests in isolation.
 *   - The lspProviders setup is async and gets re-wired per project root;
 *     decoupling the cache lifecycle from that setup means a future
 *     refactor of lspProviders can't accidentally drop cache invalidation.
 *
 * Capacity policy:
 *   - LRU with a soft cap (default 64 entries). A 64-file working set
 *     covers every typical IDE session; older entries are evicted
 *     least-recently-used.
 *   - cap is per-instance so a host can size up for big monorepos
 *     without recompiling.
 */

export interface SymbolCacheKey {
  /** Monaco model.uri.toString() — uniquely identifies the open file. */
  uri: string;
  /** Monaco model.getVersionId() — monotonic, bumped on every edit. */
  versionId: number;
}

export interface SymbolCacheEntry<T> {
  /** The cached document-symbol payload (already in Monaco's shape). */
  symbols: T;
  /**
   * Insertion / last-read timestamp. Updated on every cache hit so
   * least-recently-used eviction is correct. Monotonic; we use a
   * counter not Date.now() so the cache is deterministic in tests.
   */
  touchedAt: number;
}

export class SymbolCache<T> {
  private readonly map = new Map<string, Map<number, SymbolCacheEntry<T>>>();
  private readonly cap: number;
  private counter = 0;

  constructor(cap = 64) {
    if (cap < 1) throw new Error("SymbolCache cap must be >= 1");
    this.cap = cap;
  }

  /** Composite key string — never escapes the class. */
  private static k(uri: string, v: number): string {
    return `${uri}\x00${v}`;
  }

  /**
   * Returns the cached value for `(uri, versionId)` or undefined if
   * (a) the URI has never been cached, OR (b) the version doesn't match
   * — i.e. the model has been edited since this entry was stored.
   *
   * Touches the entry on a hit (refreshes its LRU recency) so a hot
   * file stays in the cache during sustained reads.
   */
  get(key: SymbolCacheKey): T | undefined {
    const byVer = this.map.get(key.uri);
    if (!byVer) return undefined;
    const entry = byVer.get(key.versionId);
    if (!entry) return undefined;
    entry.touchedAt = ++this.counter;
    return entry.symbols;
  }

  /**
   * Cache `symbols` under `(uri, versionId)`. Any prior entries for the
   * SAME uri at DIFFERENT versions are removed in the same call — there
   * is no value to keeping an obsolete version of a file's symbol tree.
   * This is BUG-010's core invariant: at most ONE versionId per URI is
   * live at any time, so a stale-after-edit hit is structurally
   * impossible.
   *
   * If the cache is over cap after insertion, the least-recently-used
   * uri is evicted whole (all its versions, though there should only
   * ever be one).
   */
  set(key: SymbolCacheKey, symbols: T): void {
    // Drop all other versions of the same URI in one pass. Edits are
    // monotonic so an earlier version is always dead weight; a later
    // version arriving "from the past" would be an out-of-order LSP
    // response — also dead weight (the newer model has moved on).
    this.map.delete(key.uri);
    const byVer = new Map<number, SymbolCacheEntry<T>>();
    byVer.set(key.versionId, { symbols, touchedAt: ++this.counter });
    this.map.set(key.uri, byVer);
    this.evictIfOverCap();
  }

  /** Drop every entry for `uri` — used on tab close or file rename. */
  invalidate(uri: string): void {
    this.map.delete(uri);
  }

  /** Drop every entry. Used on dispose() / project switch. */
  clear(): void {
    this.map.clear();
    this.counter = 0;
  }

  /** Current entry count — exposed for tests / observability. */
  size(): number {
    return this.map.size;
  }

  private evictIfOverCap(): void {
    if (this.map.size <= this.cap) return;
    // Find the LRU URI by the smallest touchedAt across its versions.
    let lruUri: string | undefined;
    let lruTouchedAt = Infinity;
    for (const [uri, byVer] of this.map) {
      // Each URI has 1 version after set() so this loop is O(1) per URI,
      // O(N) total over the cache — N capped at `cap`, default 64.
      for (const entry of byVer.values()) {
        if (entry.touchedAt < lruTouchedAt) {
          lruTouchedAt = entry.touchedAt;
          lruUri = uri;
        }
      }
    }
    if (lruUri !== undefined) this.map.delete(lruUri);
  }
}
