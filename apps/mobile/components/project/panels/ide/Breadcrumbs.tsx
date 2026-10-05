import { ChevronRight } from "lucide-react-native";

/**
 * File path trail above the editor. Every segment is clickable: it reveals
 * that folder (or the file itself) in the Explorer, like VS Code's breadcrumbs.
 */
export function Breadcrumbs({
  path,
  onReveal,
}: {
  path: string;
  /** Reveal a workspace-relative folder/file path in the Explorer. */
  onReveal?: (path: string) => void;
}) {
  const parts = path.split("/").filter(Boolean);
  return (
    <div
      aria-label="Breadcrumbs"
      className="flex h-7 items-center gap-1 overflow-hidden whitespace-nowrap bg-[color:var(--ide-bg)] px-3 text-[12px] text-[color:var(--ide-muted)] border-b border-[color:var(--ide-border)]"
    >
      {parts.map((p, i) => {
        const last = i === parts.length - 1;
        const target = parts.slice(0, i + 1).join("/");
        return (
          <span key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight size={12} className="shrink-0" />}
            {onReveal ? (
              <button
                type="button"
                onClick={() => onReveal(target)}
                title={last ? `Reveal ${target} in Explorer` : `Reveal folder ${target}`}
                className={`truncate rounded px-0.5 hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)] ${
                  last ? "text-[color:var(--ide-text)]" : ""
                }`}
              >
                {p}
              </button>
            ) : (
              <span className={last ? "text-[color:var(--ide-text)]" : ""}>{p}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
