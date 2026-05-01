import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Footprints, Sprout, AlertTriangle } from "lucide-react";

export interface DiningSpot {
  id: string;
  name: string;
  chef?: string;
  neighborhood: string;
  address: string;
  /** Walk time (minutes) from the trip's anchor point. Subway-only spots get high numbers. */
  walkMinFromAnchor: number;
  transitNote?: string;
  pricePerPerson: number;
  vibe: string;
  /** What makes this spot special — sourcing story, signature dish, room quality. */
  highlight: string;
  /** Optional dietary flag — set when the menu has something the traveler avoids. */
  dietaryFlag?: { label: string; severity: "warn" | "block" };
  reserveUrl: string;
}

interface DiningListProps {
  /** Curated dining picks for the trip. The agent populates this list. */
  spots: DiningSpot[];
  title?: string;
  footnote?: string;
}

export function DiningList({
  spots,
  title = "Dining · Curated",
  footnote = "Verify availability before recommending. Walk times are honest from the trip anchor.",
}: DiningListProps) {
  return (
    <Card className="bg-white dark:bg-zinc-900/40 border-zinc-200 dark:border-zinc-800 p-5">
      <div className="flex items-baseline justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sprout className="h-4 w-4 text-emerald-500" />
          <h2 className="text-sm uppercase tracking-[0.2em] text-zinc-600 dark:text-zinc-400">
            {title}
          </h2>
        </div>
        <span className="text-xs font-mono text-zinc-500 dark:text-zinc-600">
          {spots.length} curated
        </span>
      </div>

      {spots.length === 0 ? (
        <div className="py-12 text-center">
          <div className="text-sm text-zinc-500">No dining picks yet.</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-600 mt-1">
            Set the trip city and dining preferences — I'll curate the list.
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {spots.map((s) => (
              <div
                key={s.id}
                className="flex items-start justify-between gap-4 p-3 rounded-md border border-transparent dark:border-zinc-800/60 bg-transparent dark:bg-zinc-950/40 hover:bg-zinc-50 dark:hover:bg-zinc-950/60 dark:hover:border-zinc-700 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-zinc-900 dark:text-zinc-100 font-medium">{s.name}</span>
                    {s.chef && (
                      <span className="text-xs font-mono text-zinc-500">· {s.chef}</span>
                    )}
                    {s.dietaryFlag && <DietaryBadge flag={s.dietaryFlag} />}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500 font-mono flex-wrap">
                    <span>{s.neighborhood}</span>
                    <span>·</span>
                    <span className="flex items-center gap-1">
                      <Footprints className="h-3 w-3" /> {s.walkMinFromAnchor}m
                    </span>
                    <span>·</span>
                    <span>${s.pricePerPerson}/pp</span>
                  </div>
                  {s.transitNote && (
                    <div className="text-[11px] font-mono text-zinc-500 dark:text-zinc-600 mt-1">
                      {s.transitNote}
                    </div>
                  )}
                  <div className="text-xs text-zinc-600 dark:text-zinc-500 mt-1.5">
                    <span className="text-emerald-500/80">why:</span> {s.highlight}
                  </div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-600 mt-0.5 italic">
                    {s.vibe}
                  </div>
                </div>
                <a
                  href={s.reserveUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center h-8 px-3 text-sm rounded-md border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors shrink-0"
                >
                  Reserve <ExternalLink className="h-3 w-3 ml-1.5" />
                </a>
              </div>
            ))}
          </div>

          <div className="mt-4 text-[10px] font-mono text-zinc-500 dark:text-zinc-600 uppercase tracking-wider">
            {footnote}
          </div>
        </>
      )}
    </Card>
  );
}

function DietaryBadge({ flag }: { flag: { label: string; severity: "warn" | "block" } }) {
  const isBlock = flag.severity === "block";
  return (
    <Badge
      variant="outline"
      className={`text-[10px] font-mono ${
        isBlock
          ? "border-red-500/40 text-red-400"
          : "border-amber-500/30 text-amber-400"
      }`}
    >
      <AlertTriangle className="h-2.5 w-2.5 mr-1" />
      {flag.label}
    </Badge>
  );
}
