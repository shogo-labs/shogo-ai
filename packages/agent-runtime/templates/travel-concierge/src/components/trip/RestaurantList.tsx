import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Phone, ExternalLink, Footprints } from "lucide-react";
import { AvailabilityBadge } from "./AvailabilityBadge";
import type { Restaurant } from "./types";

interface Props {
  restaurants: Restaurant[];
  onCallRequest?: (r: Restaurant) => void;
}

export function RestaurantList({ restaurants, onCallRequest }: Props) {
  return (
    <Card className="bg-white dark:bg-zinc-900/40 border-zinc-200 dark:border-zinc-800 p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm uppercase tracking-[0.2em] text-zinc-600 dark:text-zinc-400">Candidates</h2>
        <span className="text-xs font-mono text-zinc-500 dark:text-zinc-600">
          {restaurants.length} {restaurants.length === 1 ? "spot" : "spots"}
        </span>
      </div>

      {restaurants.length === 0 ? (
        <div className="py-12 text-center">
          <div className="text-sm text-zinc-500">Nothing yet.</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-600 mt-1">
            Trip prompt → discovery → availability check → list.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {restaurants.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-4 p-3 rounded-md border border-transparent dark:border-zinc-800/60 bg-transparent dark:bg-zinc-950/40 hover:bg-zinc-50 dark:hover:bg-zinc-950/60 dark:hover:border-zinc-700 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-900 dark:text-zinc-100 font-medium truncate">{r.name}</span>
                  <AvailabilityBadge status={r.availability} />
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500 font-mono">
                  <span>{r.cuisine}</span>
                  <span>·</span>
                  <span>{r.neighborhood}</span>
                  {r.walkMinutes !== undefined && (
                    <>
                      <span>·</span>
                      <span className="flex items-center gap-1">
                        <Footprints className="h-3 w-3" /> {r.walkMinutes}m
                      </span>
                    </>
                  )}
                  {r.pricePerPerson !== undefined && (
                    <>
                      <span>·</span>
                      <span>${r.pricePerPerson}/pp</span>
                    </>
                  )}
                </div>
                {r.notes && <div className="text-xs text-zinc-500 dark:text-zinc-600 mt-1 italic">{r.notes}</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {r.availability === "phone-only" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                    onClick={() => onCallRequest?.(r)}
                  >
                    <Phone className="h-3 w-3 mr-1.5" />
                    Want me to call?
                  </Button>
                )}
                {r.bookingUrl && r.availability === "available" && (
                  <a
                    href={r.bookingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center h-8 px-3 text-sm rounded-md border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                  >
                    Book <ExternalLink className="h-3 w-3 ml-1.5" />
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
