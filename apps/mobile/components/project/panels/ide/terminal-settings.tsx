// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { useEffect, useState } from "react"

const KEY = "shogo.desktop.terminal.settings.v1"

const DEFAULTS = {
  gpuEnabled: true,
  restorePolicy: "silent",
  shellIntegrationEnabled: true,
  telemetryEnabled: false,
  fontLigatures: true,
}

export function TerminalSettingsPane() {
  const [settings, setSettings] = useState(DEFAULTS)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) setSettings({ ...DEFAULTS, ...JSON.parse(raw) })
    } catch {}
  }, [])
  const set = (patch: Partial<typeof DEFAULTS>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    try { localStorage.setItem(KEY, JSON.stringify(next)) } catch {}
  }
  return (
    <div className="mt-4">
      <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
        Terminal
      </div>
      <div className="flex flex-col gap-1 rounded border border-[color:var(--ide-border)] bg-[color:var(--ide-panel)] p-1">
        <Toggle label="GPU renderer" value={settings.gpuEnabled} onChange={(v) => set({ gpuEnabled: v })} />
        <Toggle label="Shell integration (OSC 633)" value={settings.shellIntegrationEnabled} onChange={(v) => set({ shellIntegrationEnabled: v })} />
        <Toggle label="Font ligatures (→ => !=)" value={settings.fontLigatures} onChange={(v) => set({ fontLigatures: v })} />
        <Toggle label="Terminal telemetry" value={settings.telemetryEnabled} onChange={(v) => set({ telemetryEnabled: v })} />
        <div className="flex items-center justify-between gap-3 rounded px-2 py-1.5">
          <div className="text-[12px] text-[color:var(--ide-text)]">Restore sessions</div>
          <select
            value={settings.restorePolicy}
            onChange={(e) => set({ restorePolicy: e.target.value as typeof settings.restorePolicy })}
            className="rounded border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-panel)] px-1.5 py-0.5 text-[11px] text-[color:var(--ide-text)]"
          >
            <option value="silent">Silent</option>
            <option value="prompt">Prompt</option>
            <option value="never">Never</option>
          </select>
        </div>
      </div>
    </div>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-[color:var(--ide-hover)]">
      <div className="text-[12px] text-[color:var(--ide-text)]">{label}</div>
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
  )
}
