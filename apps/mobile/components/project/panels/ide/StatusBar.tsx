import { Check } from "lucide-react-native";

export function StatusBar({
  language,
  line,
  col,
  saved,
}: {
  language: string;
  line: number;
  col: number;
  saved: boolean;
}) {
  return (
    <div className="flex h-6 items-center justify-between bg-[color:var(--ide-primary)] px-3 text-[12px] text-white">
      <div className="flex items-center gap-4" />
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
