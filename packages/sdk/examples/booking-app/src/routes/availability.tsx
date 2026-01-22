/**
 * Availability Management
 * 
 * Configure available time slots for booking.
 */

import { createFileRoute, useRouter, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { getTimeSlots, createTimeSlot, deleteTimeSlot, createDefaultSlots, DAY_NAMES, type TimeSlotType } from '../utils/timeslots'

export const Route = createFileRoute('/availability')({
  loader: async ({ context }) => {
    if (!context.user) {
      return { timeSlots: [] }
    }
    const timeSlots = await getTimeSlots({ data: { userId: context.user.id } })
    return { timeSlots }
  },
  component: AvailabilityPage,
})

function AvailabilityPage() {
  const { user } = Route.useRouteContext()
  const { timeSlots } = Route.useLoaderData()
  const router = useRouter()
  const [showAdd, setShowAdd] = useState(false)
  const [loading, setLoading] = useState(false)

  if (!user) {
    return (
      <article style={{ textAlign: 'center', padding: '3rem' }}>
        <h1>Not Authorized</h1>
        <Link to="/">Go to Setup</Link>
      </article>
    )
  }

  // Group slots by day
  const slotsByDay: Record<number, TimeSlotType[]> = {}
  for (let i = 0; i < 7; i++) {
    slotsByDay[i] = timeSlots.filter((s) => s.dayOfWeek === i)
  }

  const handleCreateDefaults = async () => {
    setLoading(true)
    try {
      await createDefaultSlots({ data: { userId: user.id } })
      router.invalidate()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create default slots')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    await deleteTimeSlot({ data: { id, userId: user.id } })
    router.invalidate()
  }

  return (
    <article>
      <header style={{ marginBottom: '1.5rem' }}>
        <Link to="/" style={{ color: '#6b7280', textDecoration: 'none' }}>← Back to Dashboard</Link>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
          <h1>Availability</h1>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {timeSlots.length === 0 && (
              <button className="outline" onClick={handleCreateDefaults} disabled={loading}>
                {loading ? 'Creating...' : 'Use Default (Mon-Fri 9-5)'}
              </button>
            )}
            <button onClick={() => setShowAdd(!showAdd)}>
              {showAdd ? 'Cancel' : '+ Add Time Slot'}
            </button>
          </div>
        </div>
      </header>

      {showAdd && (
        <TimeSlotForm
          userId={user.id}
          onComplete={() => {
            setShowAdd(false)
            router.invalidate()
          }}
        />
      )}

      {timeSlots.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#666', background: '#f9fafb', borderRadius: '0.5rem' }}>
          <p>No availability set. Add time slots to allow customers to book appointments.</p>
        </div>
      ) : (
        <div>
          {DAY_NAMES.map((dayName, dayIndex) => {
            const daySlots = slotsByDay[dayIndex]
            if (daySlots.length === 0) return null

            return (
              <div key={dayIndex} className="day-schedule">
                <h4>{dayName}</h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {daySlots.map((slot) => (
                    <div
                      key={slot.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.25rem 0.5rem',
                        background: slot.isActive ? '#dbeafe' : '#f3f4f6',
                        borderRadius: '0.25rem',
                        fontSize: '0.875rem',
                      }}
                    >
                      <span>{slot.startTime} - {slot.endTime}</span>
                      <button
                        style={{
                          padding: '0',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: '#9ca3af',
                          fontSize: '1rem',
                        }}
                        onClick={() => handleDelete(slot.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <footer style={{ marginTop: '2rem', fontSize: '0.875rem', color: '#666' }}>
        <p>Time slots define when customers can book appointments. Available times are calculated based on service duration.</p>
      </footer>
    </article>
  )
}

function TimeSlotForm({ userId, onComplete }: { userId: string; onComplete: () => void }) {
  const [form, setForm] = useState({
    dayOfWeek: 1, // Monday
    startTime: '09:00',
    endTime: '17:00',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createTimeSlot({
        data: {
          userId,
          dayOfWeek: form.dayOfWeek,
          startTime: form.startTime,
          endTime: form.endTime,
        },
      })
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create time slot')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ background: '#f9fafb', padding: '1rem', borderRadius: '0.5rem', marginBottom: '1rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
        <label>
          Day of Week
          <select value={form.dayOfWeek} onChange={(e) => setForm({ ...form, dayOfWeek: parseInt(e.target.value) })}>
            {DAY_NAMES.map((name, index) => (
              <option key={index} value={index}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Start Time
          <input
            type="time"
            value={form.startTime}
            onChange={(e) => setForm({ ...form, startTime: e.target.value })}
          />
        </label>
        <label>
          End Time
          <input
            type="time"
            value={form.endTime}
            onChange={(e) => setForm({ ...form, endTime: e.target.value })}
          />
        </label>
      </div>
      {error && <p style={{ color: '#e00', fontSize: '0.875rem' }}>{error}</p>}
      <button type="submit" disabled={saving} style={{ marginTop: '0.5rem' }}>
        {saving ? 'Adding...' : 'Add Time Slot'}
      </button>
    </form>
  )
}
