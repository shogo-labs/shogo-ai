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
    <div className="max-w-md mx-auto mt-16">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Booking App</h1>
        <p className="text-gray-500 mt-2">Appointment scheduling with <strong>@shogo-ai/sdk</strong></p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="email"
          placeholder="Your email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="text"
          placeholder="Your name / Business name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {loading ? 'Setting up...' : 'Get Started'}
        </button>
      </form>

      <p className="mt-8 text-center text-xs text-gray-400">
        Create services, set availability, and accept bookings.
      </p>
    </div>
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
    <div>
      <header className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-500">{user.name || user.email}</p>
        </div>
        <div className="flex gap-2">
          <Link to="/services">
            <button className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">
              Services
            </button>
          </Link>
          <Link to="/availability">
            <button className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">
              Availability
            </button>
          </Link>
          <Link to="/bookings">
            <button className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">
              All Bookings
            </button>
          </Link>
        </div>
      </header>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-3xl font-bold text-gray-900">{stats.upcoming}</p>
            <p className="text-sm text-gray-500">Upcoming</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-3xl font-bold text-gray-900">{stats.today}</p>
            <p className="text-sm text-gray-500">Today</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-3xl font-bold text-gray-900">{stats.pending}</p>
            <p className="text-sm text-gray-500">Pending</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-3xl font-bold text-gray-900">{stats.total}</p>
            <p className="text-sm text-gray-500">Total</p>
          </div>
        </div>
      )}

      {/* Booking Link */}
      {bookingUrl && (
        <div className="bg-blue-50 p-4 rounded-lg mb-6">
          <p className="font-medium text-gray-900 mb-2">Your booking page:</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={bookingUrl}
              readOnly
              className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
            />
            <button
              onClick={() => navigator.clipboard.writeText(bookingUrl)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {services.length === 0 && (
        <div className="bg-yellow-50 border border-yellow-200 p-4 rounded-lg mb-6">
          <p className="text-gray-800">
            <strong>Get started:</strong>{' '}
            <Link to="/services" className="text-blue-600 hover:underline">Create your first service</Link> and{' '}
            <Link to="/availability" className="text-blue-600 hover:underline">set your availability</Link> to start accepting bookings.
          </p>
        </div>
      )}

      {/* Recent Bookings */}
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Bookings</h2>
      {bookings.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg text-gray-400">
          <p>No bookings yet.</p>
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          {bookings.map((booking) => (
            <div key={booking.id} className="flex items-center gap-4 p-4 border-b border-gray-100 last:border-0">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  {booking.service && (
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: booking.service.color }} />
                  )}
                  <strong className="text-gray-900">{booking.customerName}</strong>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium uppercase ${
                    booking.status === 'PENDING' ? 'bg-yellow-100 text-yellow-800' :
                    booking.status === 'CONFIRMED' ? 'bg-green-100 text-green-800' :
                    booking.status === 'COMPLETED' ? 'bg-blue-100 text-blue-800' :
                    'bg-red-100 text-red-800'
                  }`}>
                    {booking.status}
                  </span>
                </div>
                <p className="text-sm text-gray-500">
                  {booking.service?.name} · {new Date(booking.startTime).toLocaleString()}
                </p>
              </div>
              {booking.status === 'PENDING' && (
                <div className="flex gap-1">
                  <button
                    onClick={() => handleStatusChange(booking.id, 'CONFIRMED')}
                    className="px-3 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => handleStatusChange(booking.id, 'CANCELLED')}
                    className="px-3 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {booking.status === 'CONFIRMED' && (
                <button
                  onClick={() => handleStatusChange(booking.id, 'COMPLETED')}
                  className="px-3 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Complete
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <footer className="mt-8 text-center text-sm text-gray-400">
        <p>All operations use <code className="bg-gray-100 px-1 rounded">shogo.db</code> (Prisma pass-through)</p>
      </footer>
    </div>
  )
}
