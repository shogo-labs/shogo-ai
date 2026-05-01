// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from "react";
import { TripHeader } from "@/components/trip/TripHeader";
import { WalkingMap } from "@/components/trip/WalkingMap";
import { RestaurantList } from "@/components/trip/RestaurantList";
import { ConfirmedBookings } from "@/components/trip/ConfirmedBookings";
import {
  LogisticsPanel,
  type HotelOption,
  type FlightLeg,
} from "@/components/trip/LogisticsPanel";
import { ShowsList, type Show } from "@/components/trip/ShowsList";
import { DiningList, type DiningSpot } from "@/components/trip/DiningList";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ThemeProvider, ThemeToggle } from "@/components/ThemeProvider";
import type { Trip, Restaurant } from "@/components/trip/types";

// ---------------------------------------------------------------------------
// Trip data
// ---------------------------------------------------------------------------
// Replace the empty values below with the active trip. The agent edits this
// file in place once the traveler shares city, dates, party size, and budget.
//
// Set `trip` to `null` to render the "Where to?" empty state instead.
// ---------------------------------------------------------------------------

const TRIP: Trip | null = null;

const HOTELS: HotelOption[] = [];

const FLIGHTS_OUT: FlightLeg[] = [];
const FLIGHTS_IN: FlightLeg[] = [];

const SHOWS: Show[] = [];

const DINING: DiningSpot[] = [];

export default function App() {
  const [trip] = useState<Trip | null>(TRIP);
  const [pendingCall, setPendingCall] = useState<Restaurant | null>(null);

  const handleCallRequest = (r: Restaurant) => {
    setPendingCall(r);
  };

  return (
    <ThemeProvider>
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
        <div className="max-w-6xl mx-auto px-6 py-8 space-y-5">
          <header className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-900 pb-4">
            <div className="flex items-baseline gap-3">
              <span className="text-lg">✈️</span>
              <span className="text-sm font-mono uppercase tracking-[0.25em] text-zinc-600 dark:text-zinc-400">
                Travel Concierge
              </span>
            </div>
            <ThemeToggle />
          </header>

          <TripHeader trip={trip} />

          <LogisticsPanel
            hotels={HOTELS}
            outbound={FLIGHTS_OUT}
            inbound={FLIGHTS_IN}
            anchorLabel="hotel"
          />

          <div className="space-y-5">
            <RestaurantList
              restaurants={trip?.candidates ?? []}
              onCallRequest={handleCallRequest}
            />

            <Tabs defaultValue="dining" className="w-full">
              <TabsList className="bg-zinc-100 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
                <TabsTrigger
                  value="dining"
                  className="text-xs font-mono uppercase tracking-wider"
                >
                  Dining
                </TabsTrigger>
                <TabsTrigger
                  value="shows"
                  className="text-xs font-mono uppercase tracking-wider"
                >
                  Shows
                </TabsTrigger>
              </TabsList>
              <TabsContent value="dining" className="mt-3">
                <DiningList spots={DINING} />
              </TabsContent>
              <TabsContent value="shows" className="mt-3">
                <ShowsList shows={SHOWS} />
              </TabsContent>
            </Tabs>

            <WalkingMap trip={trip} />
            <ConfirmedBookings bookings={trip?.bookings ?? []} />
          </div>

          {pendingCall && (
            <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
              <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6 max-w-md w-full">
                <h3 className="text-zinc-900 dark:text-zinc-100 font-medium mb-2">
                  Place call to {pendingCall.name}?
                </h3>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
                  I'll dial {pendingCall.phoneNumber ?? "their reservation line"} and ask
                  about availability matching your trip dates. You'll get the transcript
                  when I'm done.
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    className="px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
                    onClick={() => setPendingCall(null)}
                  >
                    Not yet
                  </button>
                  <button
                    className="px-3 py-1.5 text-sm bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded hover:bg-amber-500/30"
                    onClick={() => {
                      console.log("[voice] call approved", pendingCall);
                      setPendingCall(null);
                    }}
                  >
                    Call now
                  </button>
                </div>
              </div>
            </div>
          )}

          <footer className="pt-4 text-[10px] font-mono text-zinc-400 dark:text-zinc-700 uppercase tracking-wider">
            discovery: web · availability: browser · phone: shogo voice
          </footer>
        </div>
      </div>
    </ThemeProvider>
  );
}
