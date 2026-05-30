import { useRef, useState } from "react";
import { RotateCcw, Upload } from "lucide-react-native";
import { DEFAULT_SETTINGS, type EditorSettings } from "./types";
import { TerminalSettingsPane } from "./terminal-settings";
import { isDesktopRuntime } from "./terminal/pty-factory";
import {
  listAvailableThemes,
  parseThemeJson,
  registerCustomTheme,
} from "./monaco/themes";
import { getMonacoRef } from "./monaco/workspaceModels";

export function SettingsPane({
  settings,
  onChange,
}: {
  settings: EditorSettings;
  onChange: (s: EditorSettings) => void;
}) {
  const set = <K extends keyof EditorSettings>(k: K, v: EditorSettings[K]) =>
    onChange({ ...settings, [k]: v });

  return (
    <div className="flex h-full flex-col">
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

      <div className="flex-1 overflow-auto px-3 pb-4 text-[12px]">
        <Section title="Editor">
          <SliderRow
            label="Font size"
            value={settings.fontSize}
            min={11}
            max={20}
            unit="px"
            onChange={(v) => set("fontSize", v)}
          />
          <SelectRow
            label="Tab size"
            value={String(settings.tabSize)}
            options={[
              { label: "2 spaces", value: "2" },
              { label: "4 spaces", value: "4" },
            ]}
            onChange={(v) => set("tabSize", parseInt(v, 10))}
          />
          <SelectRow
            label="Word wrap"
            value={settings.wordWrap}
            options={[
              { label: "Off", value: "off" },
              { label: "On", value: "on" },
            ]}
            onChange={(v) => set("wordWrap", v as EditorSettings["wordWrap"])}
          />
          <SelectRow
            label="Line numbers"
            value={settings.lineNumbers}
            options={[
              { label: "On", value: "on" },
              { label: "Off", value: "off" },
              { label: "Relative", value: "relative" },
            ]}
            onChange={(v) => set("lineNumbers", v as EditorSettings["lineNumbers"])}
          />
          <SelectRow
            label="Render whitespace"
            value={settings.renderWhitespace}
            options={[
              { label: "None", value: "none" },
              { label: "Boundary", value: "boundary" },
              { label: "All", value: "all" },
            ]}
            onChange={(v) =>
              set("renderWhitespace", v as EditorSettings["renderWhitespace"])
            }
          />
        </Section>

        <Section title="Display">
          <ToggleRow
            label="Minimap"
            hint="Show code overview on the right"
            value={settings.minimap}
            onChange={(v) => set("minimap", v)}
          />
          <ToggleRow
            label="Bracket pair colorization"
            hint="Rainbow matching brackets"
            value={settings.bracketPairs}
            onChange={(v) => set("bracketPairs", v)}
          />
        </Section>

        <Section title="Save">
          <ToggleRow
            label="Auto save"
            hint="Save the active file after you pause typing (~1s), and when switching tabs"
            value={settings.autoSave}
            onChange={(v) => set("autoSave", v)}
          />
          <ToggleRow
            label="Format on save"
            hint="Coming soon — Prettier integration"
            value={settings.formatOnSave}
            onChange={(v) => set("formatOnSave", v)}
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
    <div className="mb-4">
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
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-[color:var(--ide-hover)]">
      <div className="min-w-0">
        <div className="text-[12px] text-[color:var(--ide-text)]">{label}</div>
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
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-[color:var(--ide-hover)]">
      <div className="text-[12px] text-[color:var(--ide-text)]">{label}</div>
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
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-[color:var(--ide-hover)]">
      <div className="text-[12px] text-[color:var(--ide-text)]">{label}</div>
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
  );
}
