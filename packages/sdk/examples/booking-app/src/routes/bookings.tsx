/**
 * Bookings List
 * 
 * View and manage all bookings with filtering.
 */

import { createFileRoute, useRouter, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { getBookings, updateBookingStatus, type BookingType } from '../utils/bookings'
import type { BookingStatus } from '../generated/prisma/client'

export const Route = createFileRoute('/bookings')({
  loader: async ({ context }) => {
    if (!context.user) {
      return { bookings: [] }
    }
    const bookings = await getBookings({ data: { userId: context.user.id } })
    return { bookings }
  },
  component: BookingsPage,
})

function BookingsPage() {
  const { user } = Route.useRouteContext()
  const { bookings } = Route.useLoaderData()
  const router = useRouter()
  const [filter, setFilter] = useState<BookingStatus | 'ALL'>('ALL')

  if (!user) {
    return (
      <article style={{ textAlign: 'center', padding: '3rem' }}>
        <h1>Not Authorized</h1>
        <Link to="/">Go to Setup</Link>
      </article>
    )
  }

  const filteredBookings = filter === 'ALL'
    ? bookings
    : bookings.filter((b) => b.status === filter)

  const handleStatusChange = async (id: string, status: BookingStatus) => {
    await updateBookingStatus({ data: { id, userId: user.id, status } })
    router.invalidate()
  }

  return (
    <article>
      <header style={{ marginBottom: '1.5rem' }}>
        <Link to="/" style={{ color: '#6b7280', textDecoration: 'none' }}>← Back to Dashboard</Link>
        <h1 style={{ marginTop: '0.5rem' }}>All Bookings</h1>
      </header>

      {/* Filters */}
      <div className="tabs">
        {(['ALL', 'PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] as const).map((status) => (
          <button
            key={status}
            className={filter === status ? 'active' : ''}
            onClick={() => setFilter(status)}
          >
            {status === 'ALL' ? 'All' : status.charAt(0) + status.slice(1).toLowerCase()}
            {status !== 'ALL' && ` (${bookings.filter((b) => b.status === status).length})`}
          </button>
        ))}
      </div>

      {filteredBookings.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#666', background: '#f9fafb', borderRadius: '0.5rem' }}>
          <p>No {filter === 'ALL' ? '' : filter.toLowerCase()} bookings found.</p>
        </div>
      ) : (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '0.5rem' }}>
          {filteredBookings.map((booking) => (
            <BookingRow
              key={booking.id}
              booking={booking}
              onStatusChange={handleStatusChange}
            />
          ))}
        </div>
      )}
    </article>
  )
}

function BookingRow({
  booking,
  onStatusChange,
}: {
  booking: BookingType
  onStatusChange: (id: string, status: BookingStatus) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="booking-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
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
          <p style={{ fontSize: '0.75rem', color: '#9ca3af', margin: '0.25rem 0 0' }}>
            {booking.customerEmail} {booking.customerPhone && `· ${booking.customerPhone}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          <button
            className="outline secondary"
            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Hide' : 'Details'}
          </button>
          {booking.status === 'PENDING' && (
            <>
              <button
                className="outline"
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                onClick={() => onStatusChange(booking.id, 'CONFIRMED')}
              >
                Confirm
              </button>
              <button
                className="outline secondary"
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                onClick={() => onStatusChange(booking.id, 'CANCELLED')}
              >
                Cancel
              </button>
            </>
          )}
          {booking.status === 'CONFIRMED' && (
            <>
              <button
                className="outline"
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                onClick={() => onStatusChange(booking.id, 'COMPLETED')}
              >
                Complete
              </button>
              <button
                className="outline secondary"
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                onClick={() => onStatusChange(booking.id, 'CANCELLED')}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: '1rem', padding: '0.75rem', background: '#f9fafb', borderRadius: '0.375rem', fontSize: '0.875rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <div>
              <strong>Confirmation Code:</strong> {booking.confirmationCode}
            </div>
            <div>
              <strong>Duration:</strong> {booking.service?.duration} minutes
            </div>
            <div>
              <strong>Start:</strong> {new Date(booking.startTime).toLocaleString()}
            </div>
            <div>
              <strong>End:</strong> {new Date(booking.endTime).toLocaleString()}
            </div>
            {booking.service && booking.service.price > 0 && (
              <div>
                <strong>Price:</strong> {booking.service.currency} {booking.service.price.toFixed(2)}
              </div>
            )}
          </div>
          {booking.notes && (
            <div style={{ marginTop: '0.5rem' }}>
              <strong>Notes:</strong> {booking.notes}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
