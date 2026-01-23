/**
 * Public Booking Page
 * 
 * Where customers book appointments.
 */

import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { getServices, type ServiceType } from '../utils/services'
import { checkAvailability, createBooking, type BookingType } from '../utils/bookings'

export const Route = createFileRoute('/book/$userId')({
  loader: async ({ params }) => {
    const services = await getServices({ data: { userId: params.userId, activeOnly: true } })
    // Get user info from the first service
    if (services.length > 0) {
      const service = await import('../utils/services').then(m => m.getService({ data: { id: services[0].id } }))
      return { services, user: service?.user || null }
    }
    return { services, user: null }
  },
  component: PublicBookingPage,
})

function PublicBookingPage() {
  const { userId } = Route.useParams()
  const { services, user } = Route.useLoaderData()
  const [step, setStep] = useState<'service' | 'date' | 'time' | 'details' | 'confirm'>('service')
  const [selectedService, setSelectedService] = useState<ServiceType | null>(null)
  const [selectedDate, setSelectedDate] = useState('')
  const [selectedSlot, setSelectedSlot] = useState<{ startTime: string; endTime: string } | null>(null)
  const [availableSlots, setAvailableSlots] = useState<{ startTime: string; endTime: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [booking, setBooking] = useState<BookingType | null>(null)

  const [customerForm, setCustomerForm] = useState({
    name: '',
    email: '',
    phone: '',
    notes: '',
  })

  if (services.length === 0) {
    return (
      <article style={{ maxWidth: '500px', margin: '4rem auto', textAlign: 'center' }}>
        <h1>No Services Available</h1>
        <p>This booking page is not currently accepting appointments.</p>
      </article>
    )
  }

  const handleServiceSelect = (service: ServiceType) => {
    setSelectedService(service)
    setStep('date')
  }

  const handleDateSelect = async (date: string) => {
    if (!selectedService) return
    setSelectedDate(date)
    setLoading(true)

    try {
      const result = await checkAvailability({
        data: { userId, serviceId: selectedService.id, date },
      })
      setAvailableSlots(result.slots)
      setStep('time')
    } catch (err) {
      alert('Failed to check availability')
    } finally {
      setLoading(false)
    }
  }

  const handleTimeSelect = (slot: { startTime: string; endTime: string }) => {
    setSelectedSlot(slot)
    setStep('details')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedService || !selectedSlot) return
    setLoading(true)

    try {
      const result = await createBooking({
        data: {
          userId,
          serviceId: selectedService.id,
          startTime: selectedSlot.startTime,
          customerName: customerForm.name,
          customerEmail: customerForm.email,
          customerPhone: customerForm.phone || undefined,
          notes: customerForm.notes || undefined,
        },
      })
      setBooking(result)
      setStep('confirm')
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to book appointment')
    } finally {
      setLoading(false)
    }
  }

  // Confirmation screen
  if (step === 'confirm' && booking) {
    return (
      <article style={{ maxWidth: '500px', margin: '2rem auto', textAlign: 'center' }}>
        <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>✓</div>
        <h1>Booking Confirmed!</h1>
        <p style={{ fontSize: '1.25rem', marginBottom: '2rem' }}>
          Your confirmation code is: <strong>{booking.confirmationCode}</strong>
        </p>
        <div style={{ background: '#f9fafb', padding: '1.5rem', borderRadius: '0.5rem', textAlign: 'left' }}>
          <h3>{selectedService?.name}</h3>
          <p><strong>Date:</strong> {new Date(booking.startTime).toLocaleDateString()}</p>
          <p><strong>Time:</strong> {new Date(booking.startTime).toLocaleTimeString()} - {new Date(booking.endTime).toLocaleTimeString()}</p>
          <p><strong>Name:</strong> {booking.customerName}</p>
          <p><strong>Email:</strong> {booking.customerEmail}</p>
          {selectedService && selectedService.price > 0 && (
            <p><strong>Price:</strong> {selectedService.currency} {selectedService.price.toFixed(2)}</p>
          )}
        </div>
        <p style={{ marginTop: '1.5rem', color: '#666', fontSize: '0.875rem' }}>
          A confirmation email has been sent to {booking.customerEmail}
        </p>
        <button
          onClick={() => {
            setStep('service')
            setSelectedService(null)
            setSelectedDate('')
            setSelectedSlot(null)
            setBooking(null)
            setCustomerForm({ name: '', email: '', phone: '', notes: '' })
          }}
          style={{ marginTop: '1rem' }}
        >
          Book Another Appointment
        </button>
      </article>
    )
  }

  // Get min date (today)
  const today = new Date().toISOString().split('T')[0]
  // Get max date (60 days from now)
  const maxDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  return (
    <article style={{ maxWidth: '600px', margin: '2rem auto' }}>
      <header style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <h1>Book an Appointment</h1>
        {user && <p style={{ color: '#666' }}>with {user.name || user.email}</p>}
      </header>

      {/* Progress indicator */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginBottom: '2rem' }}>
        {['service', 'date', 'time', 'details'].map((s, i) => (
          <div
            key={s}
            style={{
              width: '2rem',
              height: '2rem',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.875rem',
              fontWeight: 500,
              background: ['service', 'date', 'time', 'details'].indexOf(step) >= i ? '#3b82f6' : '#e5e7eb',
              color: ['service', 'date', 'time', 'details'].indexOf(step) >= i ? 'white' : '#9ca3af',
            }}
          >
            {i + 1}
          </div>
        ))}
      </div>

      {/* Step 1: Select Service */}
      {step === 'service' && (
        <div>
          <h2>Select a Service</h2>
          <div>
            {services.map((service) => (
              <div
                key={service.id}
                className="service-card"
                onClick={() => handleServiceSelect(service)}
                style={{ cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <span className="color-dot" style={{ backgroundColor: service.color }} />
                  <strong>{service.name}</strong>
                </div>
                {service.description && (
                  <p style={{ color: '#666', fontSize: '0.875rem', margin: '0.25rem 0' }}>
                    {service.description}
                  </p>
                )}
                <p style={{ color: '#9ca3af', fontSize: '0.875rem', margin: '0.5rem 0 0' }}>
                  {service.duration} min · {service.price > 0 ? `${service.currency} ${service.price.toFixed(2)}` : 'Free'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Step 2: Select Date */}
      {step === 'date' && selectedService && (
        <div>
          <button className="outline secondary" onClick={() => setStep('service')} style={{ marginBottom: '1rem' }}>
            ← Back
          </button>
          <h2>Select a Date</h2>
          <p style={{ color: '#666', marginBottom: '1rem' }}>
            Booking: {selectedService.name} ({selectedService.duration} min)
          </p>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => handleDateSelect(e.target.value)}
            min={today}
            max={maxDate}
            style={{ width: '100%' }}
          />
          {loading && <p>Checking availability...</p>}
        </div>
      )}

      {/* Step 3: Select Time */}
      {step === 'time' && selectedService && (
        <div>
          <button className="outline secondary" onClick={() => setStep('date')} style={{ marginBottom: '1rem' }}>
            ← Back
          </button>
          <h2>Select a Time</h2>
          <p style={{ color: '#666', marginBottom: '1rem' }}>
            {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          {availableSlots.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#666', background: '#f9fafb', borderRadius: '0.5rem' }}>
              <p>No available times for this date. Please select another date.</p>
            </div>
          ) : (
            <div className="time-slot-grid">
              {availableSlots.map((slot, i) => (
                <div
                  key={i}
                  className={`time-slot ${selectedSlot?.startTime === slot.startTime ? 'selected' : ''}`}
                  onClick={() => handleTimeSelect(slot)}
                >
                  {new Date(slot.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step 4: Enter Details */}
      {step === 'details' && selectedService && selectedSlot && (
        <div>
          <button className="outline secondary" onClick={() => setStep('time')} style={{ marginBottom: '1rem' }}>
            ← Back
          </button>
          <h2>Your Details</h2>
          <div style={{ background: '#f0f9ff', padding: '1rem', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
            <p style={{ margin: 0 }}>
              <strong>{selectedService.name}</strong><br />
              {new Date(selectedSlot.startTime).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}<br />
              {new Date(selectedSlot.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - {new Date(selectedSlot.endTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              {selectedService.price > 0 && <><br />{selectedService.currency} {selectedService.price.toFixed(2)}</>}
            </p>
          </div>
          <form onSubmit={handleSubmit}>
            <label>
              Your Name *
              <input
                type="text"
                value={customerForm.name}
                onChange={(e) => setCustomerForm({ ...customerForm, name: e.target.value })}
                required
              />
            </label>
            <label>
              Email Address *
              <input
                type="email"
                value={customerForm.email}
                onChange={(e) => setCustomerForm({ ...customerForm, email: e.target.value })}
                required
              />
            </label>
            <label>
              Phone Number
              <input
                type="tel"
                value={customerForm.phone}
                onChange={(e) => setCustomerForm({ ...customerForm, phone: e.target.value })}
              />
            </label>
            <label>
              Notes
              <textarea
                value={customerForm.notes}
                onChange={(e) => setCustomerForm({ ...customerForm, notes: e.target.value })}
                rows={3}
                placeholder="Any special requests or information"
              />
            </label>
            <button type="submit" disabled={loading}>
              {loading ? 'Booking...' : 'Confirm Booking'}
            </button>
          </form>
        </div>
      )}

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: '#666' }}>
        <p>Powered by Booking App</p>
      </footer>
    </article>
  )
}
