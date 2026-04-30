import { ChevronRight } from "lucide-react-native";
import type { ReactNode } from "react";

export function Breadcrumbs({
  path,
  trailing,
}: {
  path: string;
  /** Optional content rendered at the right edge — used for QuickActions. */
  trailing?: ReactNode;
}) {
  const parts = path.split("/").filter(Boolean);
  return (
    <div className="flex h-7 items-center gap-1 bg-[color:var(--ide-bg)] px-3 text-[12px] text-[color:var(--ide-muted)] border-b border-[color:var(--ide-border)]">
      <div className="flex flex-1 min-w-0 items-center gap-1 truncate">
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={12} />}
            <span className={i === parts.length - 1 ? "text-[color:var(--ide-text)]" : ""}>{p}</span>
          </span>
        ))}
      </div>
      {trailing && <div className="ml-2 shrink-0">{trailing}</div>}
    </div>
  );
}
