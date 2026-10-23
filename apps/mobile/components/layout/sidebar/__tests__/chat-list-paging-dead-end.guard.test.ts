// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A `ChatSessionList` that pages must have somewhere for "See all" to go.
 *
 * The list draws 5 chats, "Show more" ten at a time up to `MAX_INLINE_CHATS`,
 * and beyond that its footer row becomes "See all (N)". With no `onSeeAll` that
 * press falls back to `handleShowMore`, which is already capped at 20 — so a
 * caller that passes neither `onSeeAll` nor `renderAll` silently hides chat 21
 * and up. That is how the phone drawer lost the row SHO-131's e2e looked for
 * after SHO-119 put it on the shared list; the drawer scrolls itself, so it
 * takes `renderAll`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const MOBILE = join(import.meta.dir, "../../../..");

const CALL_SITES = [
  "components/layout/MobileWorkspaceShell.tsx",
  "components/layout/sidebar/ProjectTreeItem.tsx",
  "components/layout/sidebar/WorkspaceChatsPanel.tsx",
];

/** The props of every `<ChatSessionList …>` in a file, brace-aware. */
function callSiteProps(source: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  while (true) {
    const start = source.indexOf("<ChatSessionList", from);
    if (start === -1) break;
    let depth = 0;
    let index = start + "<ChatSessionList".length;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (depth === 0 && char === "/" && source[index + 1] === ">") break;
      else if (depth === 0 && char === ">") break;
    }
    blocks.push(source.slice(start, index + 2));
    from = index + 2;
  }
  return blocks;
}

describe("ChatSessionList paging", () => {
  for (const relative of CALL_SITES) {
    test(`${relative} can reach every chat it loads`, () => {
      const source = readFileSync(join(MOBILE, relative), "utf8");
      const blocks = callSiteProps(source);
      expect(blocks.length, `${relative} renders ChatSessionList`).toBeGreaterThan(0);
      for (const block of blocks) {
        const line = block.split("\n")[0].trim();
        const hasSeeAll = /\bonSeeAll[=\s]/.test(block);
        const rendersAll = /\brenderAll\b/.test(block);
        expect(
          hasSeeAll || rendersAll,
          `${relative} ${line} pages without onSeeAll: chats past MAX_INLINE_CHATS would be unreachable`,
        ).toBe(true);
      }
    });
  }

  test("the phone drawer draws every side chat it loads", () => {
    const source = readFileSync(
      join(MOBILE, "components/layout/MobileWorkspaceShell.tsx"),
      "utf8",
    );
    const drawer = callSiteProps(source).filter(
      (block) => /renderAll/.test(block) && !/onSeeAll[=\s]/.test(block),
    );
    // The Chats section and the Archived group: both scroll themselves.
    expect(drawer.length).toBe(2);
  });
});
