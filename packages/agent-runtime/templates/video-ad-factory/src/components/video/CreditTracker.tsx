import { Coins } from "lucide-react";
import type { CreditUsage } from "./types";

interface CreditTrackerProps {
  credits: CreditUsage | null;
}

export function CreditTracker({ credits }: CreditTrackerProps) {
  if (!credits) return null;

  const pct = credits.total > 0 ? (credits.remaining / credits.total) * 100 : 0;
  const barColor =
    pct > 50
      ? "bg-emerald-500"
      : pct > 20
        ? "bg-amber-500"
        : "bg-red-500";

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50">
      <Coins className="h-4 w-4 text-zinc-400 dark:text-zinc-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-xs font-mono text-zinc-600 dark:text-zinc-300">
            {credits.remaining.toLocaleString()} / {credits.total.toLocaleString()}
          </span>
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">credits</span>
        </div>
        <div className="h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
