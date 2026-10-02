import {
  MINIMAP_SCALE_OPTIONS,
  MINIMAP_SIDE_OPTIONS,
  MINIMAP_SIZE_OPTIONS,
  coerceMinimapScale,
  coerceMinimapSide,
  coerceMinimapSize,
} from "./minimap-settings";
import { createContext, useContext, useRef, useState } from "react";
import { settingValuesEqual } from "./settings-form";
import { RotateCcw, Upload } from "lucide-react-native";
import { DEFAULT_SETTINGS, type EditorSettings } from "./types";
import { FONT_FAMILY_OPTIONS } from "./useEditorFont";
import { TerminalSettingsPane } from "./terminal-settings";
import { isDesktopRuntime } from "./terminal/pty-factory";
import {
  listAvailableThemes,
  parseThemeJson,
  registerCustomTheme,
} from "./monaco/themes";
import { getMonacoRef } from "./monaco/workspaceModels";

interface SettingsCtxValue {
  query: string;
  settings: EditorSettings;
  reset: (k: keyof EditorSettings) => void;
}
const SettingsCtx = createContext<SettingsCtxValue | null>(null);

/** Hides a row that doesn't match the search box (label, hint or key). */
function RowShell({
  k,
  label,
  hint,
  children,
}: {
  k?: keyof EditorSettings;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const ctx = useContext(SettingsCtx);
  const q = ctx?.query.trim().toLowerCase() ?? "";
  if (q) {
    const hay = `${label} ${hint ?? ""} ${k ?? ""}`.toLowerCase();
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return null;
  }
  return <div data-setting-row>{children}</div>;
}

/** Label plus a "modified" dot and per-setting reset when it differs from the default. */
function RowLabel({ k, label }: { k?: keyof EditorSettings; label: string }) {
  const ctx = useContext(SettingsCtx);
  const modified =
    !!k && !!ctx && !settingValuesEqual(ctx.settings[k], (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k]);
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-[color:var(--ide-text)]">
      {modified && (
        <span
          title="Modified from default"
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--ide-active-ring)]"
        />
      )}
      <span>{label}</span>
      {modified && k && (
        <button
          type="button"
          title="Reset to default"
          aria-label={`Reset ${label}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            ctx?.reset(k);
          }}
          className="rounded p-0.5 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
        >
          <RotateCcw size={10} />
        </button>
      )}
    </div>
  );
}

export function SettingsPane({
  settings,
  onChange,
}: {
  settings: EditorSettings;
  onChange: (s: EditorSettings) => void;
}) {
  const set = <K extends keyof EditorSettings>(k: K, v: EditorSettings[K]) =>
    onChange({ ...settings, [k]: v });
  const [query, setQuery] = useState("");
  const ctx: SettingsCtxValue = {
    query,
    settings,
    reset: (k) => onChange({ ...settings, [k]: (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k] }),
  };

  return (
    <SettingsCtx.Provider value={ctx}>
    <div className={`flex h-full flex-col ${query.trim() ? "settings-searching" : ""}`}>
      <style>{`.settings-searching .settings-section:not(:has([data-setting-row])) { display: none; }`}</style>
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
          Settings
        </span>
        <button
          onClick={() => onChange(DEFAULT_SETTINGS)}
          title="Reset to defaults"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
        >
          <RotateCcw size={11} /> Reset
        </button>
      </div>

      <div className="px-3 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
          placeholder="Search settings"
          aria-label="Search settings"
          className="w-full rounded border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-input-bg)] px-2 py-1 text-[12px] text-[color:var(--ide-text)] outline-none placeholder:text-[color:var(--ide-muted)] focus:border-[color:var(--ide-active-ring)]"
        />
      </div>

      <div className="flex-1 overflow-auto px-3 pb-4 text-[12px]">
        <Section title="Editor">
          <SliderRow
            k="fontSize" label="Font size"
            value={settings.fontSize}
            min={11}
            max={20}
            unit="px"
            onChange={(v) => set("fontSize", v)}
          />
          {/*
            BUG-012 — single Font family setting. The select carries the
            FULL font-family stack as its `value` (not just the primary
            name) so the resolved CSS string is identical to what every
            consumer reads. If the persisted value doesn't match any
            curated option (e.g. an old payload, or a hand-edited stack
            via localStorage), we DON'T fall back silently — the select
            shows "Custom" so the user sees the state. Picking any
            curated option from there restores standard behaviour.
          */}
          <SelectRow
            k="fontFamily" label="Font family"
            value={
              FONT_FAMILY_OPTIONS.some((o) => o.value === settings.fontFamily)
                ? settings.fontFamily
                : "__custom__"
            }
            options={[
              ...FONT_FAMILY_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
              ...(FONT_FAMILY_OPTIONS.some((o) => o.value === settings.fontFamily)
                ? []
                : [{ label: "Custom (from settings file)", value: "__custom__" }]),
            ]}
            onChange={(v) => {
              // Ignore the "__custom__" sentinel — selecting it would
              // wipe the user's hand-edited stack. Only react to real
              // curated values.
              if (v !== "__custom__") set("fontFamily", v);
            }}
          />
          <ToggleRow
            k="insertSpaces"
            label="Insert spaces"
            hint="Pressing Tab inserts spaces (files with detectable indentation keep theirs)"
            value={settings.insertSpaces}
            onChange={(v) => set("insertSpaces", v)}
          />
          <SelectRow
            k="tabSize" label="Tab size"
            value={String(settings.tabSize)}
            options={[
              { label: "2 spaces", value: "2" },
              { label: "4 spaces", value: "4" },
            ]}
            onChange={(v) => set("tabSize", parseInt(v, 10))}
          />
          <SliderRow
            k="terminalFontSize"
            label="Terminal font size"
            value={settings.terminalFontSize}
            min={9}
            max={24}
            unit="px"
            onChange={(v) => set("terminalFontSize", v)}
          />
          <SliderRow
            k="lineHeight"
            label="Line height (0 = auto)"
            value={settings.lineHeight}
            min={0}
            max={40}
            unit="px"
            onChange={(v) => set("lineHeight", v)}
          />
          <SelectRow
            k="cursorStyle"
            label="Cursor style"
            value={settings.cursorStyle}
            options={[
              { label: "Line", value: "line" },
              { label: "Block", value: "block" },
              { label: "Underline", value: "underline" },
            ]}
            onChange={(v) => set("cursorStyle", v as EditorSettings["cursorStyle"])}
          />
          <ToggleRow
            k="fontLigatures"
            label="Font ligatures"
            hint="Render => != >= as single glyphs (JetBrains Mono, Fira Code)"
            value={settings.fontLigatures}
            onChange={(v) => set("fontLigatures", v)}
          />
          <SelectRow
            k="wordWrap" label="Word wrap"
            value={settings.wordWrap}
            options={[
              { label: "Off", value: "off" },
              { label: "On", value: "on" },
            ]}
            onChange={(v) => set("wordWrap", v as EditorSettings["wordWrap"])}
          />
          <SelectRow
            k="lineNumbers" label="Line numbers"
            value={settings.lineNumbers}
            options={[
              { label: "On", value: "on" },
              { label: "Off", value: "off" },
              { label: "Relative", value: "relative" },
            ]}
            onChange={(v) => set("lineNumbers", v as EditorSettings["lineNumbers"])}
          />
          <SelectRow
            k="renderWhitespace" label="Render whitespace"
            value={settings.renderWhitespace}
            options={[
              { label: "None", value: "none" },
              { label: "Boundary", value: "boundary" },
              { label: "Selection", value: "selection" },
              { label: "Trailing", value: "trailing" },
              { label: "All", value: "all" },
            ]}
            onChange={(v) =>
              set("renderWhitespace", v as EditorSettings["renderWhitespace"])
            }
          />
        </Section>

        <Section title="Display">
          <ToggleRow
            k="minimap" label="Minimap"
            hint="Show code overview on the right"
            value={settings.minimap}
            onChange={(v) => set("minimap", v)}
          />
          {settings.minimap && (
            <>
              <SelectRow
                k="minimapSide" label="Minimap side"
                value={settings.minimapSide}
                options={MINIMAP_SIDE_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
                onChange={(v) => set("minimapSide", coerceMinimapSide(v, "right"))}
              />
              <SelectRow
                k="minimapSize" label="Minimap size"
                value={settings.minimapSize}
                options={MINIMAP_SIZE_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
                onChange={(v) => set("minimapSize", coerceMinimapSize(v, "proportional"))}
              />
              <SelectRow
                k="minimapScale" label="Minimap scale"
                value={String(settings.minimapScale)}
                options={MINIMAP_SCALE_OPTIONS.map((o) => ({ label: o.label, value: String(o.value) }))}
                onChange={(v) => set("minimapScale", coerceMinimapScale(Number(v), 1))}
              />
            </>
          )}
          <ToggleRow
            k="bracketPairs" label="Bracket pair colorization"
            hint="Rainbow matching brackets"
            value={settings.bracketPairs}
            onChange={(v) => set("bracketPairs", v)}
          />
        </Section>

        <Section title="Save">
          <ToggleRow
            k="autoSave" label="Auto save"
            hint="Save the active file after you pause typing (~1s), and when switching tabs"
            value={settings.autoSave}
            onChange={(v) => set("autoSave", v)}
          />
          <SelectRow
            k="autoSaveDelay"
            label="Auto save delay"
            value={String(settings.autoSaveDelay)}
            options={[
              { label: "0.5 s", value: "500" },
              { label: "1 s", value: "1000" },
              { label: "2 s", value: "2000" },
              { label: "5 s", value: "5000" },
            ]}
            onChange={(v) => set("autoSaveDelay", parseInt(v, 10))}
          />
          <ToggleRow
            k="formatOnSave" label="Format on save"
            hint="Run the language formatter (JSON, CSS, HTML, TS/JS) before every save"
            value={settings.formatOnSave}
            onChange={(v) => set("formatOnSave", v)}
          />
          <ToggleRow
            k="trimTrailingWhitespace" label="Trim trailing whitespace"
            hint="Remove spaces and tabs at the end of lines when you save (⌘S)"
            value={settings.trimTrailingWhitespace}
            onChange={(v) => set("trimTrailingWhitespace", v)}
          />
          <ToggleRow
            k="insertFinalNewline" label="Insert final newline"
            hint="End files with a single newline when you save (⌘S)"
            value={settings.insertFinalNewline}
            onChange={(v) => set("insertFinalNewline", v)}
          />
        </Section>

        {isDesktopRuntime() && (
          <ThemeSection
            value={settings.editorTheme}
            onChange={(v) => set("editorTheme", v)}
          />
        )}

        <TerminalSettingsPane />

        <div className="mt-4 rounded border border-[color:var(--ide-border)] bg-[color:var(--ide-panel)] p-2 text-[10px] text-[color:var(--ide-muted)]">
          Settings are stored in{" "}
          <code className="text-[color:var(--ide-text)]">localStorage</code> under{" "}
          <code className="text-[color:var(--ide-text)]">shogo.ide.settings</code>.
        </div>
      </div>
    </div>
    </SettingsCtx.Provider>
  );
}

function ThemeSection({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const themes = listAvailableThemes();
  const [error, setError] = useState<string | null>(null);

  const handleImport = async (file: File) => {
    setError(null);
    let text: string;
    try {
      // File.text() can reject for permission/abort/IO errors. Surface them
      // as an inline message instead of an unhandled promise rejection.
      text = await file.text();
    } catch (e) {
      setError(`failed to read file: ${(e as Error).message || String(e)}`);
      return;
    }
    const parsed = parseThemeJson(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const monaco = getMonacoRef();
    if (!monaco) {
      setError("Monaco not mounted yet — open a file and try again.");
      return;
    }
    try {
      const id = registerCustomTheme(monaco, parsed.theme);
      onChange(id);
    } catch (e) {
      setError(`failed to register theme: ${(e as Error).message || String(e)}`);
    }
  };

  return (
    <Section title="Color theme">
      <SelectRow
        label="Editor theme"
        value={value ?? ""}
        options={[
          { label: "Default (follows app theme)", value: "" },
          ...themes.map((t) => ({ label: `${t.label}${t.origin === "custom" ? " (custom)" : ""}`, value: t.id })),
        ]}
        onChange={(v) => onChange(v)}
      />
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex-1 text-[12px] text-[color:var(--ide-text)]">
          Import theme JSON
          <div className="text-[10px] text-[color:var(--ide-muted)]">
            Monaco `IStandaloneThemeData` shape — base, colors, rules.
          </div>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1 rounded border border-[color:var(--ide-border)] px-2 py-1 text-[11px] hover:bg-[color:var(--ide-hover-subtle)]"
        >
          <Upload size={11} /> Import…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImport(f);
            e.target.value = "";
          }}
        />
      </div>
      {error && (
        <div className="mx-3 mb-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10.5px] text-red-300">
          {error}
        </div>
      )}
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-section mb-4">
      <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
        {title}
      </div>
      <div className="flex flex-col gap-1 rounded border border-[color:var(--ide-border)] bg-[color:var(--ide-panel)] p-1">
        {children}
      </div>
    </div>
  );
}

function ToggleRow({
  k,
  label,
  hint,
  value,
  onChange,
}: {
  k?: keyof EditorSettings;
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <RowShell k={k} label={label} hint={hint}>
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-[color:var(--ide-hover)]">
      <div className="min-w-0">
        <RowLabel k={k} label={label} />
        {hint && <div className="truncate text-[10px] text-[color:var(--ide-muted)]">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${
          value ? "bg-[color:var(--ide-active-ring)]" : "bg-[color:var(--ide-border-strong)]"
        }`}
      >
        <span
          aria-hidden
          className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-[color:var(--ide-toggle-knob)] transition-transform duration-150 ${
            value ? "translate-x-3" : "translate-x-0"
          }`}
        />
      </button>
    </label>
    </RowShell>
  );
}

function SelectRow({
  k,
  label,
  value,
  options,
  onChange,
}: {
  k?: keyof EditorSettings;
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <RowShell k={k} label={label}>
    <div className="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-[color:var(--ide-hover)]">
      <RowLabel k={k} label={label} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="no-focus-ring rounded border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-panel)] px-1.5 py-0.5 text-[11px] text-[color:var(--ide-text)] outline-none hover:border-[color:var(--ide-active-ring)]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
    </RowShell>
  );
}

function SliderRow({
  k,
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  k?: keyof EditorSettings;
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <RowShell k={k} label={label}>
    <div className="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-[color:var(--ide-hover)]">
      <RowLabel k={k} label={label} />
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          className="h-1 w-24 accent-[color:var(--ide-active-ring)]"
        />
        <span className="w-10 text-right text-[11px] text-[color:var(--ide-muted)]">
          {value}
          {unit}
        </span>
      </div>
    </div>
    </RowShell>
  );
}
