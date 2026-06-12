import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react-native";

export function ExtensionActionsMenu({
  onInstallVsix,
  onCheckUpdates,
  onShowRunning,
  onStartBisect,
}: {
  onInstallVsix: () => void;
  onCheckUpdates: () => void;
  onShowRunning: () => void;
  onStartBisect: () => void;
}) {
  return (
    <div className="group relative">
      <button title="More Actions" className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]">
        <MoreHorizontal size={15} />
      </button>
      <div className="pointer-events-none absolute right-0 top-6 z-20 hidden w-56 rounded border border-[color:var(--ide-border)] bg-[color:var(--ide-panel)] py-1 text-[11px] shadow-lg group-hover:block group-hover:pointer-events-auto">
        <MenuButton onClick={onCheckUpdates}>Check for Extension Updates</MenuButton>
        <MenuButton onClick={onShowRunning}>Show Running Extensions</MenuButton>
        <MenuButton onClick={onStartBisect}>Start Extension Bisect</MenuButton>
        <div className="my-1 border-t border-[color:var(--ide-border)]" />
        <MenuButton onClick={onInstallVsix}>Install from VSIX...</MenuButton>
      </div>
    </div>
  );
}

function MenuButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="block w-full px-3 py-1.5 text-left text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]">
      {children}
    </button>
  );
}
