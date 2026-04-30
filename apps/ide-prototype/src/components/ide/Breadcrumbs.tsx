import { ChevronRight } from "lucide-react";
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
    <div className="flex h-7 items-center gap-1 bg-[#1e1e1e] px-3 text-[12px] text-[#858585] border-b border-[#2a2a2a]">
      <div className="flex flex-1 min-w-0 items-center gap-1 truncate">
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={12} />}
            <span className={i === parts.length - 1 ? "text-[#cccccc]" : ""}>{p}</span>
          </span>
        ))}
      </div>
      {trailing && <div className="ml-2 shrink-0">{trailing}</div>}
    </div>
  );
}
