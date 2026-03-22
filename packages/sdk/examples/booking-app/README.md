# Booking App - Shogo SDK Example

A **service booking and appointment scheduling application** demonstrating intermediate **@shogo-ai/sdk** patterns.

## What This Template Does

- Create and manage bookable services with pricing
- Set weekly availability (time slots by day of week)
- Accept bookings through a public booking page
- Manage booking statuses (pending → confirmed → completed)
- Track booking statistics

## Key Patterns Demonstrated

| Pattern | Implementation |
|---------|----------------|
| **Enums** | `BookingStatus` for workflow states |
| **Date/Time Handling** | Time slots, availability checking, conflict detection |
| **Status Management** | PENDING → CONFIRMED → COMPLETED workflow |
| **Public Routes** | Customer-facing booking page |
| **Aggregations** | Booking statistics and counts |
| **Filtering** | Status and date-range filtering |

## Getting Started

1. Install dependencies:
   ```bash
   bun install
   ```

2. Set up the database:
   ```bash
   # Create a PostgreSQL database and set DATABASE_URL in .env
   echo "DATABASE_URL=postgresql://user:pass@localhost:5432/booking_app" > .env
   bun run db:push
   ```

3. Start the development server:
   ```bash
   bun run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000)

## Project Structure

```
booking-app/
├── prisma/
│   └── schema.prisma    # User, Service, TimeSlot, Booking models
├── src/
│   ├── lib/
│   │   ├── db.ts        # Prisma client
│   │   └── shogo.ts     # SDK client setup
│   ├── routes/
│   │   ├── __root.tsx   # Root layout
│   │   ├── index.tsx    # Dashboard
│   │   ├── services.tsx # Service management
│   │   ├── availability.tsx # Time slot management
│   │   ├── bookings.tsx # Booking list with filters
│   │   └── book.$userId.tsx # Public booking page
│   └── utils/
│       ├── user.ts      # User operations
│       ├── services.ts  # Service CRUD
│       ├── timeslots.ts # Availability management
│       └── bookings.ts  # Booking operations
├── package.json
└── vite.config.ts
```

## Data Model

```prisma
enum BookingStatus {
  PENDING
  CONFIRMED
  CANCELLED
  COMPLETED
}

model Service {
  id          String  @id
  name        String
  duration    Int     // minutes
  price       Float
  currency    String
  isActive    Boolean
  bookings    Booking[]
}

model TimeSlot {
  id        String  @id
  dayOfWeek Int     // 0-6 (Sun-Sat)
  startTime String  // "HH:MM"
  endTime   String  // "HH:MM"
  isActive  Boolean
}

model Booking {
  id               String        @id
  serviceId        String
  status           BookingStatus
  startTime        DateTime
  endTime          DateTime
  customerName     String
  customerEmail    String
  confirmationCode String        @unique
}
```

## SDK Usage Examples

### Creating a Service

```typescript
const service = await shogo.db.service.create({
  data: {
    userId: user.id,
    name: 'Consultation',
    duration: 60,
    price: 99.00,
    currency: 'USD',
  },
})
```

### Setting Availability

```typescript
// Create Mon-Fri 9am-5pm slots
const slots = [1, 2, 3, 4, 5].map(day => ({
  userId: user.id,
  dayOfWeek: day,
  startTime: '09:00',
  endTime: '17:00',
}))

await shogo.db.timeSlot.createMany({
  data: slots,
})
```

### Checking Availability

```typescript
const bookings = await shogo.db.booking.findMany({
  where: {
    userId,
    startTime: { gte: startOfDay, lte: endOfDay },
    status: { in: ['PENDING', 'CONFIRMED'] },
  },
})
```

### Creating a Booking with Enum

```typescript
const booking = await shogo.db.booking.create({
  data: {
    userId,
    serviceId,
    startTime,
    endTime,
    customerName: 'John Doe',
    customerEmail: 'john@example.com',
    confirmationCode: 'ABC123',
    status: 'PENDING', // Enum value
  },
})
```

### Updating Status

```typescript
await shogo.db.booking.update({
  where: { id: bookingId },
  data: { status: 'CONFIRMED' },
})
```

### Filtering by Status

```typescript
const pendingBookings = await shogo.db.booking.findMany({
  where: {
    userId,
    status: 'PENDING',
  },
  orderBy: { startTime: 'asc' },
})
```

## Booking Flow

1. **Service Provider Setup:**
   - Create account
   - Add services with pricing
   - Set weekly availability

2. **Customer Books:**
   - Visit public booking page `/book/{userId}`
   - Select service → date → time → enter details
   - Receives confirmation code

3. **Service Provider Manages:**
   - View pending bookings
   - Confirm or cancel
   - Mark as completed

## When to Use This Template

✅ **Use this template when:**
- Building appointment scheduling systems
- Creating service booking platforms
- Need time slot and availability management
- Require status-based workflow (pending/confirmed/completed)
- Building Calendly-like applications

❌ **Consider other templates when:**
- Simple contact/feedback forms (use `feedback-form`)
- Resource inventory without time-based booking
- E-commerce product ordering (use `ecommerce` when available)
