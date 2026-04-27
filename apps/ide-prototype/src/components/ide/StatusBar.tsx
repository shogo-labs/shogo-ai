import { GitBranch, AlertCircle, AlertTriangle, Check } from "lucide-react";

export function StatusBar({
  branch,
  language,
  line,
  col,
  problems,
  warnings,
  saved,
}: {
  branch: string;
  language: string;
  line: number;
  col: number;
  problems: number;
  warnings: number;
  saved: boolean;
}) {
  return (
    <div className="flex h-6 items-center justify-between bg-[#0078d4] px-3 text-[12px] text-white">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1">
          <GitBranch size={12} /> {branch}
        </span>
        <span className="flex items-center gap-1">
          <AlertCircle size={12} /> {problems}
        </span>
        <span className="flex items-center gap-1">
          <AlertTriangle size={12} /> {warnings}
        </span>
      </div>
      <div className="flex items-center gap-4">
        <span>
          Ln {line}, Col {col}
        </span>
        <span>{language}</span>
        <span>UTF-8</span>
        <span className="flex items-center gap-1">
          {saved ? <Check size={12} /> : <Circle />}
          {saved ? "Saved" : "Unsaved"}
        </span>
      </div>
    </div>
  );
}

function Circle() {
  return <span className="inline-block h-2 w-2 rounded-full bg-white/80" />;
}
