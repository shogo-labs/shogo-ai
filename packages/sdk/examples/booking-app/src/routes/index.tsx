/**
 * Booking App - Dashboard
 * 
 * Shows booking stats and upcoming appointments.
 */

import { createFileRoute, useRouter, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { createUser, type UserType } from '../utils/user'
import { getBookingStats, getBookings, updateBookingStatus, type BookingType, type BookingStats } from '../utils/bookings'
import { getServices, type ServiceType } from '../utils/services'
import type { BookingStatus } from '@prisma/client'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    if (!context.user) {
      return { stats: null, bookings: [], services: [] }
    }
    const [stats, bookings, services] = await Promise.all([
      getBookingStats({ data: { userId: context.user.id } }),
      getBookings({ data: { userId: context.user.id } }),
      getServices({ data: { userId: context.user.id } }),
    ])
    return { stats, bookings: bookings.slice(0, 10), services }
  },
  component: Dashboard,
})

function Dashboard() {
  const { user } = Route.useRouteContext()
  const { stats, bookings, services } = Route.useLoaderData()
  const router = useRouter()

  if (!user) {
    return <SetupForm onComplete={() => router.invalidate()} />
  }

  return <DashboardView user={user} stats={stats} bookings={bookings} services={services} />
}

function SetupForm({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) return

    setLoading(true)
    setError('')

    try {
      await createUser({ data: { email, name: name || undefined } })
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
    } finally {
      setLoading(false)
    }
  }

  return (
    <article style={{ maxWidth: '400px', margin: '4rem auto' }}>
      <header style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <h1>Booking App</h1>
        <p>Appointment scheduling with <strong>@shogo-ai/sdk</strong></p>
      </header>

      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="Your email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="text"
          placeholder="Your name / Business name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {error && <p style={{ color: '#e00', fontSize: '0.875rem' }}>{error}</p>}
        <button type="submit" disabled={loading}>
          {loading ? 'Setting up...' : 'Get Started'}
        </button>
      </form>

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: '#666' }}>
        <p>Create services, set availability, and accept bookings.</p>
      </footer>
    </article>
  )
}

function DashboardView({ 
  user, 
  stats, 
  bookings,
  services 
}: { 
  user: UserType
  stats: BookingStats | null
  bookings: BookingType[]
  services: ServiceType[]
}) {
  const router = useRouter()

  const handleStatusChange = async (id: string, status: BookingStatus) => {
    await updateBookingStatus({ data: { id, userId: user.id, status } })
    router.invalidate()
  }

  const bookingUrl = typeof window !== 'undefined' && services.length > 0
    ? `${window.location.origin}/book/${user.id}`
    : null

  return (
    <article>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ marginBottom: '0.25rem' }}>Dashboard</h1>
          <p style={{ color: '#666', margin: 0 }}>{user.name || user.email}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to="/services">
            <button className="outline">Services</button>
          </Link>
          <Link to="/availability">
            <button className="outline">Availability</button>
          </Link>
          <Link to="/bookings">
            <button className="outline">All Bookings</button>
          </Link>
        </div>
      </header>

      {/* Stats */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
          <div className="stat-card">
            <h3>{stats.upcoming}</h3>
            <p>Upcoming</p>
          </div>
          <div className="stat-card">
            <h3>{stats.today}</h3>
            <p>Today</p>
          </div>
          <div className="stat-card">
            <h3>{stats.pending}</h3>
            <p>Pending</p>
          </div>
          <div className="stat-card">
            <h3>{stats.total}</h3>
            <p>Total</p>
          </div>
        </div>
      )}

      {/* Booking Link */}
      {bookingUrl && (
        <div style={{ background: '#f0f9ff', padding: '1rem', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
          <p style={{ margin: '0 0 0.5rem', fontWeight: 500 }}>Your booking page:</p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input type="text" value={bookingUrl} readOnly style={{ flex: 1, marginBottom: 0 }} />
            <button onClick={() => navigator.clipboard.writeText(bookingUrl)} style={{ marginBottom: 0 }}>
              Copy
            </button>
          </div>
        </div>
      )}

      {services.length === 0 && (
        <div style={{ background: '#fef3c7', padding: '1rem', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
          <p style={{ margin: 0 }}>
            <strong>Get started:</strong>{' '}
            <Link to="/services">Create your first service</Link> and{' '}
            <Link to="/availability">set your availability</Link> to start accepting bookings.
          </p>
        </div>
      )}

      {/* Recent Bookings */}
      <h2>Recent Bookings</h2>
      {bookings.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: '#666', background: '#f9fafb', borderRadius: '0.5rem' }}>
          <p>No bookings yet.</p>
        </div>
      ) : (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '0.5rem' }}>
          {bookings.map((booking) => (
            <div key={booking.id} className="booking-row">
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  {booking.service && (
                    <span className="color-dot" style={{ backgroundColor: booking.service.color }} />
                  )}
                  <strong>{booking.customerName}</strong>
                  <span className={`status-badge status-${booking.status.toLowerCase()}`}>
                    {booking.status}
                  </span>
                </div>
                <p style={{ fontSize: '0.875rem', color: '#666', margin: 0 }}>
                  {booking.service?.name} · {new Date(booking.startTime).toLocaleString()}
                </p>
              </div>
              {booking.status === 'PENDING' && (
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  <button
                    className="outline"
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                    onClick={() => handleStatusChange(booking.id, 'CONFIRMED')}
                  >
                    Confirm
                  </button>
                  <button
                    className="outline secondary"
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                    onClick={() => handleStatusChange(booking.id, 'CANCELLED')}
                  >
                    Cancel
                  </button>
                </div>
              )}
              {booking.status === 'CONFIRMED' && (
                <button
                  className="outline"
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                  onClick={() => handleStatusChange(booking.id, 'COMPLETED')}
                >
                  Complete
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.875rem', color: '#666' }}>
        <p>All operations use <code>shogo.db</code> (Prisma pass-through)</p>
      </footer>
    </article>
  )
}
