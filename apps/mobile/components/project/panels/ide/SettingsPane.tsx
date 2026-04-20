import { RotateCcw } from "lucide-react-native";
import { DEFAULT_SETTINGS, type EditorSettings } from "./types";

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
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#858585]">
          Settings
        </span>
        <button
          onClick={() => onChange(DEFAULT_SETTINGS)}
          title="Reset to defaults"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
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
            label="Format on save"
            hint="Coming soon — Prettier integration"
            value={settings.formatOnSave}
            onChange={(v) => set("formatOnSave", v)}
          />
        </Section>

        <div className="mt-4 rounded border border-[#2a2a2a] bg-[#1a1a1a] p-2 text-[10px] text-[#858585]">
          Settings are stored in{" "}
          <code className="text-[#cccccc]">localStorage</code> under{" "}
          <code className="text-[#cccccc]">shogo.ide.settings</code>.
        </div>
      </div>
    </div>
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
      <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-[#858585]">
        {title}
      </div>
      <div className="flex flex-col gap-1 rounded border border-[#2a2a2a] bg-[#1a1a1a] p-1">
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
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-[#2a2a2a]">
      <div className="min-w-0">
        <div className="text-[12px] text-[#cccccc]">{label}</div>
        {hint && <div className="truncate text-[10px] text-[#858585]">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${
          value ? "bg-[#0078d4]" : "bg-[#3a3a3a]"
        }`}
      >
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 2,
            left: 2,
            width: 12,
            height: 12,
            borderRadius: 9999,
            background: "#ffffff",
            transform: `translateX(${value ? 12 : 0}px)`,
            transition: "transform 150ms",
          }}
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
    <div className="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-[#2a2a2a]">
      <div className="text-[12px] text-[#cccccc]">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="no-focus-ring rounded border border-[#3a3a3a] bg-[#1a1a1a] px-1.5 py-0.5 text-[11px] text-[#cccccc] outline-none hover:border-[#0078d4]"
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
    <div className="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-[#2a2a2a]">
      <div className="text-[12px] text-[#cccccc]">{label}</div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          className="h-1 w-24 accent-[#0078d4]"
        />
        <span className="w-10 text-right text-[11px] text-[#858585]">
          {value}
          {unit}
        </span>
      </div>
    </div>
  );
}
