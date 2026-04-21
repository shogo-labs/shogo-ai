import { ChevronRight } from "lucide-react-native";

export function Breadcrumbs({ path }: { path: string }) {
  const parts = path.split("/").filter(Boolean);
  return (
    <div className="flex h-7 items-center gap-1 bg-[#1e1e1e] px-3 text-[12px] text-[#858585] border-b border-[#2a2a2a]">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={12} />}
          <span className={i === parts.length - 1 ? "text-[#cccccc]" : ""}>{p}</span>
        </span>
      ))}
    </div>
  );
}
