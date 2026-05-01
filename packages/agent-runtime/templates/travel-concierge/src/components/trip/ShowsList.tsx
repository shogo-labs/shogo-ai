import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ExternalLink, Footprints, Theater, Search } from "lucide-react";

export interface Show {
  id: string;
  title: string;
  /** Venue name, e.g. theater, hall, club. */
  venue: string;
  address: string;
  /** Walk time (minutes) from the trip's anchor point. */
  walkMinFromAnchor: number;
  fromPrice: number;
  /** Free-form category badge — e.g. "Long-runner", "Buzzy", "New", "Revival", "Comedy", "Concert". */
  category: string;
  blurb: string;
  ticketsUrl: string;
}

interface ShowsListProps {
  /** Curated shows for the trip. The agent populates this list. */
  shows: Show[];
  /** Header label, default "Shows · Currently Playing". */
  title?: string;
  /** Footnote under the list — clarify how walk times were measured, etc. */
  footnote?: string;
}

export function ShowsList({
  shows,
  title = "Shows · Currently Playing",
  footnote = 'Prices are "from" floors. Verify date availability before booking.',
}: ShowsListProps) {
  const categories = useMemo(() => {
    const set = new Set<string>(["All"]);
    for (const s of shows) set.add(s.category);
    return Array.from(set);
  }, [shows]);

  const [filter, setFilter] = useState<string>("All");
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    return shows
      .filter((s) => {
        if (filter !== "All" && s.category !== filter) return false;
        if (query && !`${s.title} ${s.venue} ${s.blurb}`.toLowerCase().includes(query.toLowerCase()))
          return false;
        return true;
      })
      .sort((a, b) => a.walkMinFromAnchor - b.walkMinFromAnchor);
  }, [filter, query, shows]);

  return (
    <Card className="bg-white dark:bg-zinc-900/40 border-zinc-200 dark:border-zinc-800 p-5">
      <div className="flex items-baseline justify-between mb-4">
        <div className="flex items-center gap-2">
          <Theater className="h-4 w-4 text-zinc-500" />
          <h2 className="text-sm uppercase tracking-[0.2em] text-zinc-600 dark:text-zinc-400">
            {title}
          </h2>
        </div>
        <span className="text-xs font-mono text-zinc-500 dark:text-zinc-600">
          {shown.length} of {shows.length}
        </span>
      </div>

      {shows.length === 0 ? (
        <div className="py-12 text-center">
          <div className="text-sm text-zinc-500">No shows yet.</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-600 mt-1">
            Ask me to pull current shows for the trip city.
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search title, venue…"
                className="h-8 pl-7 text-sm bg-zinc-100/60 dark:bg-zinc-950/40"
              />
            </div>
            <div className="flex gap-1 flex-wrap">
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setFilter(c)}
                  className={`px-2.5 py-1 text-xs rounded-md font-mono transition-colors ${
                    filter === c
                      ? "bg-zinc-900 dark:bg-zinc-100 text-zinc-50 dark:text-zinc-900"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            {shown.map((s) => (
              <div
                key={s.id}
                className="flex items-start justify-between gap-4 p-3 rounded-md border border-transparent dark:border-zinc-800/60 bg-transparent dark:bg-zinc-950/40 hover:bg-zinc-50 dark:hover:bg-zinc-950/60 dark:hover:border-zinc-700 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-zinc-900 dark:text-zinc-100 font-medium">{s.title}</span>
                    <Badge variant="outline" className="text-[10px] font-mono border-zinc-700 text-zinc-500">
                      {s.category}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500 font-mono flex-wrap">
                    <span>{s.venue}</span>
                    <span>·</span>
                    <span className="flex items-center gap-1">
                      <Footprints className="h-3 w-3" /> {s.walkMinFromAnchor}m
                    </span>
                    <span>·</span>
                    <span>from ${s.fromPrice}</span>
                  </div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-600 mt-1 italic">{s.blurb}</div>
                </div>
                <a
                  href={s.ticketsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center h-8 px-3 text-sm rounded-md border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors shrink-0"
                >
                  Tickets <ExternalLink className="h-3 w-3 ml-1.5" />
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
