import { diffLines, type Change } from "diff";
import type { WorkspaceService } from "./types";

export type HunkStatus = "pending" | "accepted" | "rejected";

export interface Hunk {
  id: string;
  /** 1-based line number in the original `before` content where this hunk starts. */
  beforeStart: number;
  beforeLines: string[];
  /** 1-based line number in the proposed `after` content where this hunk starts. */
  afterStart: number;
  afterLines: string[];
  status: HunkStatus;
}

export interface Proposal {
  id: string;
  rootId: string;
  path: string;
  before: string;
  after: string;
  hunks: Hunk[];
  createdAt: number;
  source: "agent" | "user";
  rationale?: string;
}

export interface ProposeArgs {
  rootId: string;
  path: string;
  after: string;
  source?: "agent" | "user";
  rationale?: string;
}

type Listener = () => void;

let proposalSeq = 1;
let hunkSeq = 1;
const newProposalId = () => `p${proposalSeq++}_${Date.now().toString(36)}`;
const newHunkId = () => `h${hunkSeq++}`;

/**
 * Splits an array of `diff` library Changes into discrete hunks.
 * A hunk is a maximal run of consecutive added/removed parts. Pure-context
 * runs are skipped.
 */
function changesToHunks(changes: Change[]): Hunk[] {
  const hunks: Hunk[] = [];
  let beforeLine = 1;
  let afterLine = 1;

  let i = 0;
  while (i < changes.length) {
    const c = changes[i];
    const lineCount = countLines(c.value);

    if (!c.added && !c.removed) {
      beforeLine += lineCount;
      afterLine += lineCount;
      i++;
      continue;
    }

    const hunkBeforeStart = beforeLine;
    const hunkAfterStart = afterLine;
    const removed: string[] = [];
    const added: string[] = [];

    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      const cc = changes[i];
      const ccLines = splitLines(cc.value);
      if (cc.removed) {
        removed.push(...ccLines);
        beforeLine += ccLines.length;
      } else if (cc.added) {
        added.push(...ccLines);
        afterLine += ccLines.length;
      }
      i++;
    }

    hunks.push({
      id: newHunkId(),
      beforeStart: hunkBeforeStart,
      beforeLines: removed,
      afterStart: hunkAfterStart,
      afterLines: added,
      status: "pending",
    });
  }

  return hunks;
}

/** Count the number of complete lines in a chunk value. */
function countLines(s: string): number {
  if (s === "") return 0;
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** Split a string into its constituent lines, dropping the implicit trailing newline. */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Rebuild a file's content by applying only the accepted hunks of a proposal.
 * Pending and rejected hunks keep the original `before` lines intact.
 */
function applyAcceptedHunks(proposal: Proposal): string {
  const beforeLines = splitLines(proposal.before);
  const out: string[] = [];
  let cursor = 0;

  const sorted = [...proposal.hunks].sort((a, b) => a.beforeStart - b.beforeStart);

  for (const hunk of sorted) {
    const hunkBeforeIdx = hunk.beforeStart - 1;
    while (cursor < hunkBeforeIdx) {
      out.push(beforeLines[cursor]);
      cursor++;
    }

    if (hunk.status === "accepted") {
      out.push(...hunk.afterLines);
      cursor += hunk.beforeLines.length;
    } else {
      for (let k = 0; k < hunk.beforeLines.length; k++) {
        if (cursor < beforeLines.length) {
          out.push(beforeLines[cursor]);
          cursor++;
        }
      }
    }
  }

  while (cursor < beforeLines.length) {
    out.push(beforeLines[cursor]);
    cursor++;
  }

  const trailing = proposal.before.endsWith("\n") ? "\n" : "";
  return out.join("\n") + (out.length > 0 ? trailing : "");
}

class ProposalStore {
  private proposals: Map<string, Proposal> = new Map();
  private listeners: Set<Listener> = new Set();
  /** Keyed by `${rootId}::${path}` — only one active proposal per file at a time. */
  private byPath: Map<string, string> = new Map();
  private services: Map<string, WorkspaceService> = new Map();

  registerService(rootId: string, service: WorkspaceService) {
    this.services.set(rootId, service);
  }

  unregisterService(rootId: string) {
    this.services.delete(rootId);
  }

  list(): Proposal[] {
    return [...this.proposals.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  getByPath(rootId: string, path: string): Proposal | undefined {
    const id = this.byPath.get(`${rootId}::${path}`);
    return id ? this.proposals.get(id) : undefined;
  }

  pendingCount(): number {
    let n = 0;
    for (const p of this.proposals.values()) {
      if (p.hunks.some((h) => h.status === "pending")) n++;
    }
    return n;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** Stage a new proposal. If one already exists for the path it is superseded. */
  async propose(args: ProposeArgs): Promise<Proposal> {
    const service = this.services.get(args.rootId);
    if (!service) {
      throw new Error(`proposalStore: no service registered for root '${args.rootId}'`);
    }

    let before = "";
    try {
      const file = await service.readFile(args.path);
      before = file.content;
    } catch {
      before = "";
    }

    const changes = diffLines(before, args.after);
    const hunks = changesToHunks(changes);

    const key = `${args.rootId}::${args.path}`;
    const existing = this.byPath.get(key);
    if (existing) this.proposals.delete(existing);

    const proposal: Proposal = {
      id: newProposalId(),
      rootId: args.rootId,
      path: args.path,
      before,
      after: args.after,
      hunks,
      createdAt: Date.now(),
      source: args.source ?? "agent",
      rationale: args.rationale,
    };

    this.proposals.set(proposal.id, proposal);
    this.byPath.set(key, proposal.id);
    this.emit();
    return proposal;
  }

  private setHunkStatus(proposalId: string, hunkId: string, status: HunkStatus): Proposal | undefined {
    const p = this.proposals.get(proposalId);
    if (!p) return undefined;
    const next: Proposal = {
      ...p,
      hunks: p.hunks.map((h) => (h.id === hunkId ? { ...h, status } : h)),
    };
    this.proposals.set(proposalId, next);
    return next;
  }

  /** Accept a single hunk and persist a partial write. */
  async acceptHunk(proposalId: string, hunkId: string): Promise<void> {
    const p = this.setHunkStatus(proposalId, hunkId, "accepted");
    if (!p) return;
    await this.writeAndMaybeClose(p);
  }

  rejectHunk(proposalId: string, hunkId: string): void {
    const p = this.setHunkStatus(proposalId, hunkId, "rejected");
    if (!p) return;
    this.maybeClose(p);
    this.emit();
  }

  /** Accept every pending hunk and write the proposed `after` content directly. */
  async acceptAll(proposalId: string): Promise<void> {
    const p = this.proposals.get(proposalId);
    if (!p) return;
    const next: Proposal = {
      ...p,
      hunks: p.hunks.map((h) => (h.status === "pending" ? { ...h, status: "accepted" } : h)),
    };
    this.proposals.set(proposalId, next);
    await this.writeAndMaybeClose(next);
  }

  rejectAll(proposalId: string): void {
    const p = this.proposals.get(proposalId);
    if (!p) return;
    this.proposals.delete(p.id);
    this.byPath.delete(`${p.rootId}::${p.path}`);
    this.emit();
  }

  rejectAllProposals(): void {
    this.proposals.clear();
    this.byPath.clear();
    this.emit();
  }

  private async writeAndMaybeClose(p: Proposal): Promise<void> {
    const service = this.services.get(p.rootId);
    if (!service) {
      throw new Error(`proposalStore: no service for root '${p.rootId}'`);
    }
    const newContent = applyAcceptedHunks(p);
    await service.writeFile(p.path, newContent, { review: false });

    const remaining = p.hunks.filter((h) => h.status === "pending");
    if (remaining.length === 0) {
      this.proposals.delete(p.id);
      this.byPath.delete(`${p.rootId}::${p.path}`);
    } else {
      const refreshed = await this.recomputeAgainstDisk(p);
      if (refreshed) this.proposals.set(refreshed.id, refreshed);
      else {
        this.proposals.delete(p.id);
        this.byPath.delete(`${p.rootId}::${p.path}`);
      }
    }
    this.emit();
  }

  private maybeClose(p: Proposal): void {
    if (!p.hunks.some((h) => h.status === "pending")) {
      this.proposals.delete(p.id);
      this.byPath.delete(`${p.rootId}::${p.path}`);
    }
  }

  private async recomputeAgainstDisk(p: Proposal): Promise<Proposal | undefined> {
    const service = this.services.get(p.rootId);
    if (!service) return undefined;
    let before = "";
    try {
      const f = await service.readFile(p.path);
      before = f.content;
    } catch {
      before = "";
    }
    const changes = diffLines(before, p.after);
    const hunks = changesToHunks(changes);
    if (hunks.length === 0) return undefined;
    return { ...p, before, hunks };
  }
}

export const proposalStore = new ProposalStore();
