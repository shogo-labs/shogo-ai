import { Card } from "@/components/ui/card";
import type { Trip } from "./types";

export function WalkingMap({ trip }: { trip: Trip | null }) {
  return (
    <Card className="bg-gradient-to-br from-emerald-50 to-white dark:from-zinc-900/40 dark:to-zinc-900/40 border-zinc-200 dark:border-zinc-800 p-0 overflow-hidden h-[280px] relative">
      <div className="absolute inset-0 hidden dark:block bg-[radial-gradient(circle_at_50%_50%,rgba(63,63,70,0.4),transparent_70%)]" />

      {!trip ? (
        <div className="relative h-full flex flex-col items-center justify-center text-center">
          <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-600 mb-2">Walking radius</div>
          <div className="text-sm text-zinc-500">Hotel will pin once trip is set</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-600 font-mono mt-3">≤ 15 min · ~0.7 mi</div>
        </div>
      ) : (
        <div className="relative h-full flex items-center justify-center">
          <div className="absolute w-48 h-48 rounded-full border border-emerald-500/20 bg-emerald-500/5" />
          <div className="absolute w-32 h-32 rounded-full border border-emerald-500/30 bg-emerald-500/5" />
          <div className="absolute w-16 h-16 rounded-full border border-emerald-500/40 bg-emerald-500/10" />
          <div className="relative z-10 flex flex-col items-center">
            <div className="h-3 w-3 rounded-full bg-emerald-400 ring-4 ring-emerald-400/20" />
            <div className="mt-2 text-xs font-mono text-zinc-600 dark:text-zinc-400">{trip.hotel ?? trip.city}</div>
          </div>
          <div className="absolute bottom-3 left-3 text-[10px] font-mono text-zinc-500 dark:text-zinc-600 uppercase tracking-wider">
            walking radius · 15 min
          </div>
        </div>
      )}
    </Card>
  );
}
