/**
 * Booking App
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { api, configureApiClient } from './generated/api-client'

interface ServiceType {
  id: string
  name: string
  description: string | null
  duration: number
  price: number
  currency: string
  isActive: boolean
  color: string
}

interface BookingType {
  id: string
  status: string
  startTime: string
  endTime: string
  customerName: string
  customerEmail: string
  customerPhone: string | null
  notes: string | null
  confirmationCode: string
  service?: ServiceType
}

interface TimeSlotType {
  id: string
  dayOfWeek: number
  startTime: string
  endTime: string
  isActive: boolean
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function App() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/')

  useEffect(() => {
    const handleHash = () => setRoute(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  // Public booking page
  if (route.startsWith('/book/')) {
    const userId = route.replace('/book/', '')
    return <PublicBookingPage userId={userId} />
  }

  // Protected dashboard
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}

const Dashboard = observer(function Dashboard() {
  const { auth } = useStores()
  const [tab, setTab] = useState<'bookings' | 'services' | 'availability'>('bookings')
  const [services, setServices] = useState<ServiceType[]>([])
  const [bookings, setBookings] = useState<BookingType[]>([])
  const [timeSlots, setTimeSlots] = useState<TimeSlotType[]>([])
  const [loading, setLoading] = useState(true)

  // Configure API client with user context
  useEffect(() => {
    if (auth.user) {
      configureApiClient({ userId: auth.user.id })
    }
  }, [auth.user?.id])

  const fetchData = useCallback(async () => {
    if (!auth.user) return
    try {
      const [svcRes, bookRes, slotRes] = await Promise.all([
        api.service.list(),
        api.booking.list({ params: { include: 'service' } }),
        api.timeSlot.list(),
      ])
      if (svcRes.ok) { setServices((svcRes.items || []) as any) }
      if (bookRes.ok) { setBookings((bookRes.items || []) as any) }
      if (slotRes.ok) { setTimeSlots((slotRes.items || []) as any) }
    } catch (err) {
      console.error('Failed to fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [auth.user])

  useEffect(() => { fetchData() }, [fetchData])

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-500">Loading...</p></div>
  }

  const shareLink = `${window.location.origin}/#/book/${auth.user?.id}`

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">📅 Booking App</h1>
        <div className="flex items-center gap-4">
          <span className="text-gray-500">{auth.user?.name || auth.user?.email}</span>
          <button onClick={() => auth.signOut()} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Sign Out</button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-6">
        {/* Share link */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <p className="text-sm text-blue-600 mb-2">Share your booking link:</p>
          <code className="text-xs bg-white px-3 py-2 rounded border border-blue-200 block truncate">{shareLink}</code>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mb-6">
          {(['bookings', 'services', 'availability'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === t ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              style={tab === t ? { backgroundColor: '#8b5cf6' } : {}}
            >
              {t === 'bookings' ? '📋 Bookings' : t === 'services' ? '🛠 Services' : '⏰ Availability'}
            </button>
          ))}
        </div>

        {tab === 'bookings' && <BookingsTab bookings={bookings} onUpdate={fetchData} />}
        {tab === 'services' && <ServicesTab services={services} userId={auth.user!.id} onUpdate={fetchData} />}
        {tab === 'availability' && <AvailabilityTab timeSlots={timeSlots} userId={auth.user!.id} onUpdate={fetchData} />}

        <footer className="text-center text-gray-400 text-sm mt-8">Built with @shogo-ai/sdk + Hono</footer>
      </div>
    </div>
  )
})

function BookingsTab({ bookings, onUpdate }: { bookings: BookingType[]; onUpdate: () => void }) {
  const handleUpdateStatus = async (id: string, status: string) => {
    await api.booking.update(id, { status } as any)
    onUpdate()
  }

  const sortedBookings = [...bookings].sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-900">Upcoming Bookings</h2>
      {sortedBookings.length === 0 ? (
        <p className="text-gray-400 text-center py-8">No bookings yet.</p>
      ) : (
        sortedBookings.map(booking => (
          <div key={booking.id} className={`bg-white rounded-xl p-5 shadow-sm border-l-4 ${
            booking.status === 'CONFIRMED' ? 'border-green-500' :
            booking.status === 'PENDING' ? 'border-yellow-200' :
            booking.status === 'CANCELLED' ? 'border-red-200' : 'border-gray-200'
          }`}>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">{booking.customerName}</h3>
                <p className="text-sm text-gray-500">{booking.customerEmail}</p>
                <p className="text-sm text-gray-600 mt-2">
                  {new Date(booking.startTime).toLocaleDateString()} {new Date(booking.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - {new Date(booking.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
                {booking.service && (
                  <span className="inline-block mt-2 text-xs px-2 py-1 rounded" style={{ backgroundColor: booking.service.color + '20', color: booking.service.color }}>
                    {booking.service.name}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-1 rounded uppercase tracking-wider ${
                  booking.status === 'CONFIRMED' ? 'bg-green-100 text-green-600' :
                  booking.status === 'PENDING' ? 'bg-yellow-50 text-yellow-600' :
                  booking.status === 'CANCELLED' ? 'bg-red-50 text-red-500' : 'bg-gray-100 text-gray-500'
                }`}>
                  {booking.status}
                </span>
                {booking.status === 'PENDING' && (
                  <>
                    <button onClick={() => handleUpdateStatus(booking.id, 'CONFIRMED')} className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700">Confirm</button>
                    <button onClick={() => handleUpdateStatus(booking.id, 'CANCELLED')} className="text-xs px-2 py-1 bg-red-50 text-red-600 rounded hover:bg-red-100">Cancel</button>
                  </>
                )}
              </div>
            </div>
            {booking.notes && <p className="text-sm text-gray-500 mt-2 italic">"{booking.notes}"</p>}
            <p className="text-xs text-gray-400 mt-2">Code: {booking.confirmationCode}</p>
          </div>
        ))
      )}
    </div>
  )
}

function ServicesTab({ services, userId, onUpdate }: { services: ServiceType[]; userId: string; onUpdate: () => void }) {
  const [showAdd, setShowAdd] = useState(false)

  const handleAdd = async (data: Partial<ServiceType>) => {
    await api.service.create({ ...data, userId } as any)
    setShowAdd(false)
    onUpdate()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this service?')) return
    await api.service.delete(id)
    onUpdate()
  }

  const handleToggle = async (id: string, isActive: boolean) => {
    await api.service.update(id, { isActive: !isActive } as any)
    onUpdate()
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold text-gray-900">Services</h2>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 text-white rounded-lg text-sm font-medium" style={{ backgroundColor: '#8b5cf6' }}>
          + Add Service
        </button>
      </div>

      {showAdd && <AddServiceForm onAdd={handleAdd} onCancel={() => setShowAdd(false)} />}

      {services.length === 0 ? (
        <p className="text-gray-400 text-center py-8">No services yet. Add your first service!</p>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {services.map(service => (
            <div key={service.id} className={`bg-white rounded-xl p-5 shadow-sm border-l-4 ${service.isActive ? '' : 'opacity-50'}`} style={{ borderColor: service.color }}>
              <div className="flex justify-between items-start">
                <h3 className="font-semibold text-gray-900">{service.name}</h3>
                <button onClick={() => handleDelete(service.id)} className="text-gray-400 hover:text-red-500">×</button>
              </div>
              {service.description && <p className="text-sm text-gray-500 mt-1">{service.description}</p>}
              <div className="mt-3 flex justify-between items-center text-sm">
                <span className="text-gray-600">{service.duration} min</span>
                <span className="font-semibold" style={{ color: service.color }}>{service.currency} {service.price}</span>
              </div>
              <button
                onClick={() => handleToggle(service.id, service.isActive)}
                className={`mt-3 w-full text-xs py-1 rounded ${service.isActive ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-600'}`}
              >
                {service.isActive ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AddServiceForm({ onAdd, onCancel }: { onAdd: (data: Partial<ServiceType>) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [duration, setDuration] = useState('60')
  const [price, setPrice] = useState('0')
  const [color, setColor] = useState('#8B5CF6')

  return (
    <div className="bg-white rounded-xl p-5 shadow-sm">
      <h3 className="font-semibold text-gray-900 mb-4">Add Service</h3>
      <div className="space-y-3">
        <input type="text" placeholder="Service name *" value={name} onChange={(e) => setName(e.target.value)} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
        <input type="text" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
        <div className="grid grid-cols-3 gap-3">
          <input type="number" placeholder="Duration (min)" value={duration} onChange={(e) => setDuration(e.target.value)} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
          <input type="number" placeholder="Price" value={price} onChange={(e) => setPrice(e.target.value)} step="0.01" className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-full h-12 rounded-lg cursor-pointer" />
        </div>
        <div className="flex gap-2">
          <button onClick={() => name && onAdd({ name, description: description || null, duration: parseInt(duration), price: parseFloat(price), color })} className="px-4 py-2 text-white rounded-lg text-sm" style={{ backgroundColor: '#8b5cf6' }}>Add</button>
          <button onClick={onCancel} className="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
        </div>
      </div>
    </div>
  )
}

function AvailabilityTab({ timeSlots, userId, onUpdate }: { timeSlots: TimeSlotType[]; userId: string; onUpdate: () => void }) {
  const [showAdd, setShowAdd] = useState(false)

  const handleAdd = async (data: { dayOfWeek: number; startTime: string; endTime: string }) => {
    await api.timeSlot.create({ ...data, userId } as any)
    setShowAdd(false)
    onUpdate()
  }

  const handleDelete = async (id: string) => {
    await api.timeSlot.delete(id)
    onUpdate()
  }

  const slotsByDay = DAYS.map((day, i) => ({
    day,
    slots: timeSlots.filter(s => s.dayOfWeek === i).sort((a, b) => a.startTime.localeCompare(b.startTime))
  }))

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold text-gray-900">Availability</h2>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 text-white rounded-lg text-sm font-medium" style={{ backgroundColor: '#8b5cf6' }}>
          + Add Time Slot
        </button>
      </div>

      {showAdd && <AddTimeSlotForm onAdd={handleAdd} onCancel={() => setShowAdd(false)} />}

      <div className="bg-white rounded-xl p-5 shadow-sm">
        {slotsByDay.map(({ day, slots }) => (
          <div key={day} className="py-3 border-b border-gray-100 last:border-0">
            <div className="flex items-center gap-4">
              <span className="w-24 font-medium text-gray-700">{day}</span>
              <div className="flex-1 flex flex-wrap gap-2">
                {slots.length === 0 ? (
                  <span className="text-gray-400 text-sm">No availability</span>
                ) : (
                  slots.map(slot => (
                    <span key={slot.id} className="inline-flex items-center gap-1 text-sm bg-green-50 text-green-600 px-2 py-1 rounded">
                      {slot.startTime} - {slot.endTime}
                      <button onClick={() => handleDelete(slot.id)} className="text-green-400 hover:text-red-500">×</button>
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AddTimeSlotForm({ onAdd, onCancel }: { onAdd: (data: { dayOfWeek: number; startTime: string; endTime: string }) => void; onCancel: () => void }) {
  const [dayOfWeek, setDayOfWeek] = useState('1')
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('17:00')

  return (
    <div className="bg-white rounded-xl p-5 shadow-sm">
      <h3 className="font-semibold text-gray-900 mb-4">Add Time Slot</h3>
      <div className="grid grid-cols-3 gap-3">
        <select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm bg-white">
          {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
        </select>
        <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
        <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
      </div>
      <div className="flex gap-2 mt-3">
        <button onClick={() => onAdd({ dayOfWeek: parseInt(dayOfWeek), startTime, endTime })} className="px-4 py-2 text-white rounded-lg text-sm" style={{ backgroundColor: '#8b5cf6' }}>Add</button>
        <button onClick={onCancel} className="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
      </div>
    </div>
  )
}

function PublicBookingPage({ userId }: { userId: string }) {
  const [provider, setProvider] = useState<{ name: string; email: string } | null>(null)
  const [services, setServices] = useState<ServiceType[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedService, setSelectedService] = useState<ServiceType | null>(null)
  const [bookingSuccess, setBookingSuccess] = useState<{ code: string } | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const [userRes, svcRes] = await Promise.all([
          fetch(`/api/users/${userId}`),
          fetch(`/api/services?userId=${userId}&isActive=true`),
        ])
        if (userRes.ok) {
          const u = await userRes.json()
          setProvider({ name: u.name || u.email, email: u.email })
        } else {
          setError('Provider not found')
        }
        if (svcRes.ok) {
          const d = await svcRes.json()
          setServices(d.items || [])
        }
      } catch (err) {
        setError('Failed to load')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [userId])

  if (loading) return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-500">Loading...</p></div>
  if (error) return <div className="min-h-screen flex items-center justify-center"><p className="text-red-500">{error}</p></div>

  if (bookingSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)' }}>
        <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md text-center">
          <div className="text-4xl mb-4">✅</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Booking Confirmed!</h1>
          <p className="text-gray-500 mb-4">Your confirmation code:</p>
          <code className="text-xl font-mono bg-gray-100 px-4 py-2 rounded">{bookingSuccess.code}</code>
          <p className="text-sm text-gray-400 mt-4">You'll receive a confirmation email shortly.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-4" style={{ background: 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)' }}>
      <div className="max-w-2xl mx-auto">
        <div className="bg-white rounded-xl shadow-lg p-6 mb-4">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">📅 Book with {provider?.name}</h1>
          <p className="text-gray-500">Select a service to book an appointment.</p>
        </div>

        {selectedService ? (
          <BookingForm
            service={selectedService}
            userId={userId}
            onBack={() => setSelectedService(null)}
            onSuccess={(code) => setBookingSuccess({ code })}
          />
        ) : (
          <div className="space-y-4">
            {services.length === 0 ? (
              <div className="bg-white rounded-xl p-6 text-center text-gray-500">No services available.</div>
            ) : (
              services.map(svc => (
                <div
                  key={svc.id}
                  onClick={() => setSelectedService(svc)}
                  className="bg-white rounded-xl p-5 shadow-sm cursor-pointer hover:shadow-md transition border-l-4"
                  style={{ borderColor: svc.color }}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-semibold text-gray-900">{svc.name}</h3>
                      {svc.description && <p className="text-sm text-gray-500 mt-1">{svc.description}</p>}
                      <p className="text-sm text-gray-600 mt-2">{svc.duration} min</p>
                    </div>
                    <span className="font-semibold" style={{ color: svc.color }}>{svc.currency} {svc.price}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function BookingForm({ service, userId, onBack, onSuccess }: { service: ServiceType; userId: string; onBack: () => void; onSuccess: (code: string) => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !email || !date || !time) return

    setLoading(true)
    setError('')

    const startTime = new Date(`${date}T${time}`)
    const endTime = new Date(startTime.getTime() + service.duration * 60000)

    try {
      const res = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          serviceId: service.id,
          customerName: name,
          customerEmail: email,
          customerPhone: phone || null,
          notes: notes || null,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
        }),
      })
      const data = await res.json()
      if (res.ok) {
        onSuccess(data.confirmationCode)
      } else {
        setError(data.error || 'Failed to book')
      }
    } catch (err) {
      setError('Failed to book')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-lg p-6">
      <button onClick={onBack} className="text-gray-500 hover:text-gray-700 mb-4">← Back to services</button>
      <h2 className="text-xl font-semibold text-gray-900 mb-1">{service.name}</h2>
      <p className="text-sm text-gray-500 mb-4">{service.duration} min • {service.currency} {service.price}</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <input type="text" placeholder="Your name *" value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
        <input type="email" placeholder="Email address *" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
        <input type="tel" placeholder="Phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
        <div className="grid grid-cols-2 gap-4">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required min={new Date().toISOString().split('T')[0]} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
        </div>
        <textarea placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
        {error && <p className="text-red-500 text-sm">{error}</p>}
        <button type="submit" disabled={loading} className="w-full px-4 py-3 text-white rounded-lg font-medium disabled:opacity-50" style={{ backgroundColor: '#8b5cf6' }}>
          {loading ? 'Booking...' : 'Confirm Booking'}
        </button>
      </form>
    </div>
  )
}
