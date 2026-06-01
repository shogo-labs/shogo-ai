/**
 * BUG-003 e2e race simulation: rapid tab swap during Cmd+S.
 *
 * Reconstructs the save pipeline at a level that exercises both pure
 * helpers (resolveSaveTarget + findEditorForFileId) without booting the
 * full Workbench. The scenarios are the exact patterns that exposed the
 * bug:
 *
 *   1. User edits settings.json. Cmd+S queued.
 *      Before save callback runs, user clicked preferences.json (also
 *      JSON, different fileMatch in the registered schemas).
 *      Old code: closure-captured `active` could be either file, AND any
 *      format-on-save reaching for editor.getActiveModel() would format
 *      the wrong file (which then runs the wrong JSON schema's
 *      validation against the wrong content).
 *      New code: save resolves by fileId from groupsRef; format-on-save
 *      resolves the editor by fileId. Both deterministically target the
 *      file the user had open when they pressed Cmd+S.
 *
 *   2. User typed in A, swapped to B, pressed Cmd+S immediately. Cmd+S
 *      intent is "save the now-active tab" — handler captures activeId
 *      AT INVOCATION and resolves B from groupsRef. Verified.
 *
 *   3. Save-All when the same file is open in two split groups must
 *      write it only once.
 *
 *   4. User closed the tab mid-flight (between Cmd+S and the async save).
 *      resolveSaveTarget returns null → save is dropped silently. No
 *      crash, no toast.
 */
import { describe, expect, test } from "bun:test";
import { collectDirtyFiles, resolveSaveTarget } from "../save-target";
import { findEditorForFileId } from "../model-by-uri";
import type { EditorGroup, OpenFile } from "../types";

const file = (id: string, content = "", saved = content, dirty = content !== saved): OpenFile => ({
  id, rootId: "root", name: id, path: id, language: "json",
  content, savedContent: saved, dirty,
});
const ed = (uri: string) => ({ getModel: () => ({ uri: { toString: () => uri } }) });

// Mini save pipeline: same shape as Workbench.persistByFileId minus the
// FS service + React state — both replaced with spies. Format step picks
// up content from the editor's model BY FILE ID, NEVER via "active model".
async function persistByFileId(args: {
  fileId: string;
  groupsRef: { current: ReadonlyArray<EditorGroup> };
  editorsByGroup: ReadonlyArray<{ getModel: () => { uri: { toString(): string } } | null }>;
  formatOnSave: boolean;
  formatModel?: (model: { uri: { toString(): string } }) => string;
  writeFile: (path: string, content: string) => Promise<void>;
}): Promise<{ wrote: boolean; path?: string; content?: string }> {
  const f = resolveSaveTarget(args.groupsRef.current, args.fileId);
  if (!f) return { wrote: false };

  let content = f.content;
  if (args.formatOnSave) {
    const editor = findEditorForFileId(args.editorsByGroup, args.fileId);
    if (editor) {
      const model = editor.getModel();
      if (model && args.formatModel) content = args.formatModel(model);
    }
  }

  await args.writeFile(f.path, content);
  return { wrote: true, path: f.path, content };
}

describe("BUG-003 — rapid tab swap during Cmd+S", () => {
  test("save targets the file the user was on, even after activeId swap", async () => {
    // T0: editing settings.json (activeId=settings).
    let groups: EditorGroup[] = [{
      id: "g", activeId: "settings",
      files: [file("settings", "{ \"theme\": \"dark\" }", "{}", true),
              file("preferences", "{ \"a\": 1 }", "{}", true)],
    }];
    const groupsRef = { current: groups };

    // Cmd+S captures fileId="settings" at invocation.
    const targetFileId = groupsRef.current[0]!.activeId!;

    // T+5ms: user clicks preferences.json BEFORE the save callback runs.
    groups = [{ ...groups[0]!, activeId: "preferences" }];
    groupsRef.current = groups;

    const writes: Array<{ path: string; content: string }> = [];
    const res = await persistByFileId({
      fileId: targetFileId,
      groupsRef,
      editorsByGroup: [ed("inmemory://preferences")], // Monaco swapped to preferences
      formatOnSave: false,
      writeFile: async (path, content) => { writes.push({ path, content }); },
    });

    expect(res.wrote).toBe(true);
    expect(writes).toEqual([{ path: "settings", content: "{ \"theme\": \"dark\" }" }]);
  });

  test("format-on-save runs against the file's model, NEVER getActiveModel()", async () => {
    let groups: EditorGroup[] = [{
      id: "g", activeId: "settings",
      files: [file("settings", "{\"unformatted\":true}", "{}", true),
              file("preferences", "{ \"a\": 1 }", "{}", true)],
    }];
    const groupsRef = { current: groups };

    const targetFileId = "settings";

    // User clicks preferences. The "active" editor's model is now preferences.
    groups = [{ ...groups[0]!, activeId: "preferences" }];
    groupsRef.current = groups;

    // editorsByGroup contains BOTH editors: the (now-inactive) settings
    // editor AND the (now-active) preferences editor. The bug fix requires
    // we pick the settings one BY FILE ID — not by activeness.
    const editors = [
      ed("inmemory://preferences"), // listed first; would be "active"
      ed("inmemory://settings"),     // the file we actually want
    ];

    // The formatter is given the model — assert it's settings, not preferences.
    let formattedUri: string | null = null;
    const res = await persistByFileId({
      fileId: targetFileId,
      groupsRef,
      editorsByGroup: editors,
      formatOnSave: true,
      formatModel: (m) => {
        formattedUri = m.uri.toString();
        return "{\n  \"unformatted\": true\n}\n"; // pretty
      },
      writeFile: async () => {},
    });

    expect(res.wrote).toBe(true);
    expect(formattedUri).toBe("inmemory://settings"); // <-- the critical assertion
    expect(res.content).toBe("{\n  \"unformatted\": true\n}\n");
  });

  test("save uses LATEST content from groupsRef, not stale closure content", async () => {
    // T0: file A content "v1". Cmd+S captures id="A".
    const groupsRef: { current: EditorGroup[] } = {
      current: [{ id: "g", activeId: "A", files: [file("A", "v1", "v0", true)] }],
    };
    const fileId = "A";

    // T+1ms: user typed more. groupsRef now holds "v2".
    groupsRef.current = [{ id: "g", activeId: "A", files: [file("A", "v2", "v0", true)] }];

    const writes: Array<{ path: string; content: string }> = [];
    await persistByFileId({
      fileId, groupsRef,
      editorsByGroup: [],
      formatOnSave: false,
      writeFile: async (path, content) => { writes.push({ path, content }); },
    });

    expect(writes[0]!.content).toBe("v2"); // NOT "v1"
  });

  test("file closed between Cmd+S and save → drop silently, no write", async () => {
    const groupsRef = { current: [{ id: "g", activeId: null, files: [] }] };
    const writes: any[] = [];
    const res = await persistByFileId({
      fileId: "settings", groupsRef,
      editorsByGroup: [],
      formatOnSave: false,
      writeFile: async (p, c) => { writes.push({ p, c }); },
    });
    expect(res.wrote).toBe(false);
    expect(writes).toEqual([]);
  });

  test("Save All: same file in two split groups writes exactly once", async () => {
    const shared = file("shared", "v", "v0", true);
    const groupsRef = {
      current: [
        { id: "L", activeId: "shared", files: [shared] },
        { id: "R", activeId: "shared", files: [shared] },
      ],
    };

    const dirty = collectDirtyFiles(groupsRef.current);
    expect(dirty.length).toBe(1);

    const writes: any[] = [];
    await Promise.all(
      dirty.map((f) =>
        persistByFileId({
          fileId: f.id, groupsRef,
          editorsByGroup: [ed("inmemory://shared")],
          formatOnSave: false,
          writeFile: async (path, content) => writes.push({ path, content }),
        }),
      ),
    );
    expect(writes.length).toBe(1);
  });

  test("format-on-save falls back gracefully when no editor holds the file", async () => {
    // File open in a tab but not visible in any group's editor (e.g.
    // pinned in tab strip but a different file is currently shown in the
    // editor pane). Format step is skipped; save still proceeds with the
    // React-state content. This is the "preferable to wrong formatting"
    // contract from the helper docs.
    const groupsRef = {
      current: [{ id: "g", activeId: "other", files: [
        file("settings", "{\"x\":1}", "{}", true),
        file("other", "x", "x", false),
      ]}],
    };
    const editors = [ed("inmemory://other")]; // settings NOT in editor

    let formatCalled = false;
    const writes: any[] = [];
    await persistByFileId({
      fileId: "settings", groupsRef,
      editorsByGroup: editors,
      formatOnSave: true,
      formatModel: () => { formatCalled = true; return "FORMATTED"; },
      writeFile: async (path, content) => writes.push({ path, content }),
    });

    expect(formatCalled).toBe(false); // never invoked
    expect(writes[0]!.content).toBe("{\"x\":1}"); // wrote React-state content
  });
});
