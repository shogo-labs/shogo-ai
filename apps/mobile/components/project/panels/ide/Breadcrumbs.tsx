import { ChevronRight } from "lucide-react-native";

export function Breadcrumbs({ path }: { path: string }) {
  const parts = path.split("/").filter(Boolean);
  return (
    <div className="flex h-7 items-center gap-1 bg-[color:var(--ide-bg)] px-3 text-[12px] text-[color:var(--ide-muted)] border-b border-[color:var(--ide-border)]">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={12} />}
          <span className={i === parts.length - 1 ? "text-[color:var(--ide-text)]" : ""}>{p}</span>
        </span>
      ))}
    </div>
  );
}
