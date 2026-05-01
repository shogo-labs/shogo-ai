import { Badge } from "@/components/ui/badge";
import type { AvailabilityStatus } from "./types";

const STYLES: Record<AvailabilityStatus, { label: string; className: string }> = {
  available: {
    label: "available",
    className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20",
  },
  unavailable: {
    label: "unavailable",
    className: "bg-red-500/10 text-red-400 border-red-500/30 hover:bg-red-500/15",
  },
  "phone-only": {
    label: "phone only",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/20",
  },
  unknown: {
    label: "unknown",
    className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30 hover:bg-zinc-500/20",
  },
};

export function AvailabilityBadge({ status }: { status: AvailabilityStatus }) {
  const s = STYLES[status];
  return (
    <Badge variant="outline" className={`font-mono text-[10px] uppercase tracking-wider ${s.className}`}>
      {s.label}
    </Badge>
  );
}
