export type AvailabilityStatus = "available" | "unavailable" | "phone-only" | "unknown";

export interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  walkMinutes?: number;
  pricePerPerson?: number;
  vibe?: string;
  source?: "resy" | "opentable" | "phone";
  bookingUrl?: string;
  phoneNumber?: string;
  availability: AvailabilityStatus;
  notes?: string;
}

export interface ConfirmedBooking {
  id: string;
  restaurantId: string;
  name: string;
  partySize: number;
  whenISO: string;
  confirmation?: string;
}

export interface Trip {
  city: string;
  startDate: string;
  endDate: string;
  hotel?: string;
  hotelLat?: number;
  hotelLng?: number;
  weather?: { tempF: number; summary: string; icon?: string };
  candidates: Restaurant[];
  bookings: ConfirmedBooking[];
}
