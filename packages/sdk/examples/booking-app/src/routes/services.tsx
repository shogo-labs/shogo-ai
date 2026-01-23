/**
 * Services Management
 * 
 * Create and manage bookable services.
 */

import { createFileRoute, useRouter, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { getServices, createService, updateService, deleteService, type ServiceType } from '../utils/services'

export const Route = createFileRoute('/services')({
  loader: async ({ context }) => {
    if (!context.user) {
      return { services: [] }
    }
    const services = await getServices({ data: { userId: context.user.id } })
    return { services }
  },
  component: ServicesPage,
})

function ServicesPage() {
  const { user } = Route.useRouteContext()
  const { services } = Route.useLoaderData()
  const router = useRouter()
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  if (!user) {
    return (
      <article style={{ textAlign: 'center', padding: '3rem' }}>
        <h1>Not Authorized</h1>
        <Link to="/">Go to Setup</Link>
      </article>
    )
  }

  return (
    <article>
      <header style={{ marginBottom: '1.5rem' }}>
        <Link to="/" style={{ color: '#6b7280', textDecoration: 'none' }}>← Back to Dashboard</Link>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
          <h1>Services</h1>
          <button onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? 'Cancel' : '+ New Service'}
          </button>
        </div>
      </header>

      {showCreate && (
        <ServiceForm
          userId={user.id}
          onComplete={() => {
            setShowCreate(false)
            router.invalidate()
          }}
        />
      )}

      {services.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#666', background: '#f9fafb', borderRadius: '0.5rem' }}>
          <p>No services yet. Create your first service to start accepting bookings!</p>
        </div>
      ) : (
        <div>
          {services.map((service) => (
            <div key={service.id} className="service-card">
              {editingId === service.id ? (
                <ServiceForm
                  userId={user.id}
                  service={service}
                  onComplete={() => {
                    setEditingId(null)
                    router.invalidate()
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <ServiceDisplay
                  service={service}
                  userId={user.id}
                  onEdit={() => setEditingId(service.id)}
                  onDelete={() => router.invalidate()}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

function ServiceForm({
  userId,
  service,
  onComplete,
  onCancel,
}: {
  userId: string
  service?: ServiceType
  onComplete: () => void
  onCancel?: () => void
}) {
  const [form, setForm] = useState({
    name: service?.name || '',
    description: service?.description || '',
    duration: service?.duration || 60,
    price: service?.price || 0,
    currency: service?.currency || 'USD',
    color: service?.color || '#3B82F6',
    isActive: service?.isActive ?? true,
  })
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      if (service) {
        await updateService({
          data: {
            id: service.id,
            userId,
            ...form,
            description: form.description || undefined,
          },
        })
      } else {
        await createService({
          data: {
            userId,
            ...form,
            description: form.description || undefined,
          },
        })
      }
      onComplete()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save service')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ background: '#f9fafb', padding: '1rem', borderRadius: '0.5rem', marginBottom: '1rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <label>
          Service Name *
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g., Consultation"
            required
          />
        </label>
        <label>
          Duration (minutes) *
          <input
            type="number"
            value={form.duration}
            onChange={(e) => setForm({ ...form, duration: parseInt(e.target.value) || 60 })}
            min={15}
            step={15}
          />
        </label>
      </div>
      <label>
        Description
        <textarea
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Optional description"
          rows={2}
        />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
        <label>
          Price
          <input
            type="number"
            value={form.price}
            onChange={(e) => setForm({ ...form, price: parseFloat(e.target.value) || 0 })}
            min={0}
            step={0.01}
          />
        </label>
        <label>
          Currency
          <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
            <option value="CAD">CAD</option>
            <option value="AUD">AUD</option>
          </select>
        </label>
        <label>
          Color
          <input
            type="color"
            value={form.color}
            onChange={(e) => setForm({ ...form, color: e.target.value })}
            style={{ height: '2.5rem', padding: '0.25rem' }}
          />
        </label>
      </div>
      {service && (
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            style={{ width: 'auto', marginBottom: 0 }}
          />
          Active (available for booking)
        </label>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
        <button type="submit" disabled={saving}>
          {saving ? 'Saving...' : service ? 'Update Service' : 'Create Service'}
        </button>
        {onCancel && (
          <button type="button" className="outline secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

function ServiceDisplay({
  service,
  userId,
  onEdit,
  onDelete,
}: {
  service: ServiceType
  userId: string
  onEdit: () => void
  onDelete: () => void
}) {
  const handleDelete = async () => {
    if (!confirm('Delete this service? This will also delete all associated bookings.')) return
    await deleteService({ data: { id: service.id, userId } })
    onDelete()
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
          <span className="color-dot" style={{ backgroundColor: service.color }} />
          <strong style={{ fontSize: '1.1rem' }}>{service.name}</strong>
          {!service.isActive && (
            <span className="status-badge status-cancelled">Inactive</span>
          )}
        </div>
        {service.description && (
          <p style={{ color: '#666', fontSize: '0.875rem', margin: '0.25rem 0' }}>
            {service.description}
          </p>
        )}
        <p style={{ color: '#9ca3af', fontSize: '0.75rem', margin: '0.5rem 0 0' }}>
          {service.duration} min · {service.price > 0 ? `${service.currency} ${service.price.toFixed(2)}` : 'Free'}
          {service._count && ` · ${service._count.bookings} bookings`}
        </p>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button className="outline" style={{ padding: '0.25rem 0.75rem', fontSize: '0.875rem' }} onClick={onEdit}>
          Edit
        </button>
        <button className="outline secondary" style={{ padding: '0.25rem 0.75rem', fontSize: '0.875rem' }} onClick={handleDelete}>
          Delete
        </button>
      </div>
    </div>
  )
}
