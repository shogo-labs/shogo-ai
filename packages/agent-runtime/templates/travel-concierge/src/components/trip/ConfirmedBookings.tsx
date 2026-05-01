import { Card } from "@/components/ui/card";
import { CheckCircle2 } from "lucide-react";
import type { ConfirmedBooking } from "./types";

export function ConfirmedBookings({ bookings }: { bookings: ConfirmedBooking[] }) {
  return (
    <Card className="bg-white dark:bg-zinc-900/40 border-zinc-200 dark:border-zinc-800 p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm uppercase tracking-[0.2em] text-zinc-600 dark:text-zinc-400">Confirmed</h2>
        <span className="text-xs font-mono text-zinc-500 dark:text-zinc-600">{bookings.length}</span>
      </div>

      {bookings.length === 0 ? (
        <div className="py-8 text-center">
          <div className="text-sm text-zinc-500">No bookings yet.</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-600 mt-1">Confirmed reservations land here.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {bookings.map((b) => {
            const when = new Date(b.whenISO);
            return (
              <div
                key={b.id}
                className="flex items-center gap-3 p-3 rounded-md border border-emerald-500/20 bg-emerald-500/5"
              >
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-zinc-900 dark:text-zinc-100 font-medium">{b.name}</div>
                  <div className="text-xs text-zinc-500 font-mono">
                    {when.toLocaleString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}{" "}
                    · party of {b.partySize}
                    {b.confirmation && ` · ${b.confirmation}`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
