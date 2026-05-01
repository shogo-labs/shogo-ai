import { Card } from "@/components/ui/card";
import { CalendarDays, MapPin, Cloud } from "lucide-react";
import type { Trip } from "./types";

export function TripHeader({ trip }: { trip: Trip | null }) {
  if (!trip) {
    return (
      <Card className="bg-white dark:bg-zinc-900/40 border-zinc-200 dark:border-zinc-800 p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">No active trip</div>
            <h1 className="text-3xl font-light text-zinc-900 dark:text-zinc-100">Where to?</h1>
            <p className="text-sm text-zinc-500 mt-2">
              Send a trip prompt — city, dates, party size — and the dashboard will populate.
            </p>
          </div>
          <div className="text-right text-zinc-500 dark:text-zinc-600 text-xs font-mono">
            <div>Tell me your cuisine, budget, and vibe.</div>
            <div>I'll save it to memory and use it on every trip.</div>
          </div>
        </div>
      </Card>
    );
  }

  const dateRange = `${trip.startDate} → ${trip.endDate}`;
  return (
    <Card className="bg-white dark:bg-zinc-900/40 border-zinc-200 dark:border-zinc-800 p-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Active trip</div>
          <h1 className="text-3xl font-light text-zinc-900 dark:text-zinc-100">{trip.city}</h1>
          <div className="flex items-center gap-4 mt-3 text-sm text-zinc-600 dark:text-zinc-400">
            <span className="flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" /> {dateRange}
            </span>
            {trip.hotel && (
              <span className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" /> {trip.hotel}
              </span>
            )}
          </div>
        </div>
        {trip.weather && (
          <div className="flex items-center gap-3 text-zinc-700 dark:text-zinc-300">
            <Cloud className="h-5 w-5 text-zinc-500" />
            <div>
              <div className="text-2xl font-light">{trip.weather.tempF}°F</div>
              <div className="text-xs text-zinc-500">{trip.weather.summary}</div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
