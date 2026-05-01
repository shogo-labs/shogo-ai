import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plane, BedDouble, ExternalLink, Check } from "lucide-react";

export interface HotelOption {
  id: string;
  name: string;
  address: string;
  /** Walk time (minutes) from this hotel to the trip's anchor point — typically the city's main draw or the traveler's nightly base. */
  walkMinToAnchor: number;
  estNightly: [number, number];
  resortFeeNightly?: number;
  vibe: string;
  pick?: boolean;
  bookingUrl: string;
  notes?: string;
}

export interface FlightLeg {
  id: string;
  carrier: string;
  /** Origin → connection(s) → destination, e.g. "SFO → JFK". */
  route: string;
  /** Local-time departure label, e.g. "Fri 6:00a". */
  depart: string;
  /** Local-time arrival label, e.g. "Fri 5:45p". */
  arrive: string;
  duration: string;
  stops: string;
  estPrice?: number;
}

interface LogisticsPanelProps {
  hotels: HotelOption[];
  outbound: FlightLeg[];
  inbound: FlightLeg[];
  flightEstRT?: [number, number];
  /** Short label for the trip anchor — used in the hotel walk-time column. Default: "anchor". */
  anchorLabel?: string;
  /** Origin → destination label for the flights header, e.g. "SFO ↔ JFK". */
  flightRouteLabel?: string;
  /** Optional advisory line shown above the flight columns. */
  flightNote?: string;
  outboundLabel?: string;
  inboundLabel?: string;
  hotelHeader?: string;
}

export function LogisticsPanel({
  hotels,
  outbound,
  inbound,
  flightEstRT,
  anchorLabel = "anchor",
  flightRouteLabel,
  flightNote,
  outboundLabel = "Outbound",
  inboundLabel = "Return",
  hotelHeader = "Hotel",
}: LogisticsPanelProps) {
  return (
    <div className="space-y-5">
      <Card className="bg-white dark:bg-zinc-900/40 border-zinc-200 dark:border-zinc-800 p-5">
        <div className="flex items-center gap-2 mb-4">
          <BedDouble className="h-4 w-4 text-amber-300" />
          <h2 className="text-sm font-mono uppercase tracking-[0.2em] text-zinc-700 dark:text-zinc-300">
            {hotelHeader}
          </h2>
        </div>
        {hotels.length === 0 ? (
          <div className="py-8 text-center text-sm text-zinc-500">
            No hotels yet — set the trip dates and I'll surface picks with live rates.
          </div>
        ) : (
          <div className="space-y-3">
            {hotels.map((h) => (
              <div
                key={h.id}
                className={`border rounded-md p-4 ${
                  h.pick
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/40"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-zinc-900 dark:text-zinc-100 font-medium">{h.name}</h3>
                      {h.pick && (
                        <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/40 text-[10px] uppercase tracking-wider">
                          <Check className="h-3 w-3 mr-1" /> Top pick
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">{h.address}</div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-2">{h.vibe}</div>
                    {h.notes && (
                      <div className="text-xs text-zinc-500 mt-1 italic">{h.notes}</div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-zinc-900 dark:text-zinc-100 font-mono text-sm">
                      ${h.estNightly[0]}–${h.estNightly[1]}
                    </div>
                    <div className="text-[10px] text-zinc-500 font-mono">/ night est.</div>
                    {h.resortFeeNightly && (
                      <div className="text-[10px] text-zinc-500 dark:text-zinc-600 font-mono mt-0.5">
                        +${h.resortFeeNightly} resort
                      </div>
                    )}
                    <div className="text-[10px] text-zinc-500 font-mono mt-1">
                      {h.walkMinToAnchor} min to {anchorLabel}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex gap-3">
                  <a
                    href={h.bookingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-amber-300 hover:text-amber-200 inline-flex items-center gap-1"
                  >
                    Book <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="bg-white dark:bg-zinc-900/40 border-zinc-200 dark:border-zinc-800 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Plane className="h-4 w-4 text-amber-300" />
            <h2 className="text-sm font-mono uppercase tracking-[0.2em] text-zinc-700 dark:text-zinc-300">
              {flightRouteLabel ? `Flights — ${flightRouteLabel}` : "Flights"}
            </h2>
          </div>
          {flightEstRT && (
            <div className="text-xs font-mono text-zinc-500">
              est. ${flightEstRT[0]}–${flightEstRT[1]} RT
            </div>
          )}
        </div>
        {flightNote && (
          <div className="text-[11px] text-zinc-500 mb-3 italic">{flightNote}</div>
        )}
        {outbound.length === 0 && inbound.length === 0 ? (
          <div className="py-8 text-center text-sm text-zinc-500">
            No flights yet — share the origin airport and I'll pull options.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FlightColumn label={outboundLabel} legs={outbound} />
            <FlightColumn label={inboundLabel} legs={inbound} />
          </div>
        )}
      </Card>
    </div>
  );
}

function FlightColumn({ label, legs }: { label: string; legs: FlightLeg[] }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2 font-mono">
        {label}
      </div>
      <div className="space-y-2">
        {legs.length === 0 ? (
          <div className="text-xs text-zinc-500 italic">—</div>
        ) : (
          legs.map((l) => (
            <div
              key={l.id}
              className="border border-zinc-200 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-950/40 rounded p-3 text-xs"
            >
              <div className="flex items-center justify-between">
                <span className="text-zinc-800 dark:text-zinc-200 font-medium">{l.carrier}</span>
                <span className="text-zinc-500 font-mono">{l.duration}</span>
              </div>
              <div className="text-zinc-600 dark:text-zinc-400 mt-1 font-mono">{l.route}</div>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-zinc-500">
                  {l.depart} → {l.arrive}
                </span>
                <span className="text-zinc-500 dark:text-zinc-600 text-[10px] uppercase tracking-wider">
                  {l.stops}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
