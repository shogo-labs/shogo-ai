/**
 * Form Editor
 * 
 * Demonstrates:
 * - Dynamic field schemas
 * - Position ordering
 * - JSON fields for options
 * - Nested includes
 */

import { createFileRoute, useRouter, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { getForm, updateForm, type FormType } from '../utils/forms'
import { addField, updateField, deleteField, FIELD_TYPES, parseFieldOptions, type FieldOption } from '../utils/fields'
import { getFormStats, type FormStats } from '../utils/submissions'

export const Route = createFileRoute('/forms/$formId')({
  loader: async ({ params, context }) => {
    if (!context.user) {
      return { form: null, stats: null }
    }
    const [form, stats] = await Promise.all([
      getForm({ data: { id: params.formId, userId: context.user.id } }),
      getFormStats({ data: { formId: params.formId, userId: context.user.id } }),
    ])
    return { form, stats }
  },
  component: FormEditor,
})

function FormEditor() {
  const { user } = Route.useRouteContext()
  const { form, stats } = Route.useLoaderData()
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'fields' | 'settings'>('fields')

  if (!user || !form) {
    return (
      <article style={{ textAlign: 'center', padding: '3rem' }}>
        <h1>Form Not Found</h1>
        <Link to="/">Back to Dashboard</Link>
      </article>
    )
  }

  const formUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/f/${form.slug}`
    : `/f/${form.slug}`

  return (
    <article>
      <header style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <Link to="/" style={{ color: '#6b7280', textDecoration: 'none' }}>← Back</Link>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ marginBottom: '0.25rem' }}>{form.name}</h1>
            <span className={`status-badge ${form.isPublished ? 'published' : 'draft'}`}>
              {form.isPublished ? 'Published' : 'Draft'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Link to="/forms/$formId/submissions" params={{ formId: form.id }}>
              <button className="outline">
                Submissions ({form._count?.submissions || 0})
              </button>
            </Link>
            {form.isPublished && (
              <Link to="/f/$slug" params={{ slug: form.slug }}>
                <button className="outline secondary">Preview</button>
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* Stats */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
          <div className="stat-card">
            <h3>{stats.total}</h3>
            <p>Total Responses</p>
          </div>
          <div className="stat-card">
            <h3>{stats.unread}</h3>
            <p>Unread</p>
          </div>
          <div className="stat-card">
            <h3>{stats.today}</h3>
            <p>Today</p>
          </div>
        </div>
      )}

      {/* Share link */}
      {form.isPublished && (
        <div style={{ background: '#f0f9ff', padding: '1rem', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
          <p style={{ margin: '0 0 0.5rem', fontWeight: 500 }}>Share your form:</p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input type="text" value={formUrl} readOnly style={{ flex: 1, marginBottom: 0 }} />
            <button onClick={() => navigator.clipboard.writeText(formUrl)} style={{ marginBottom: 0 }}>
              Copy
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        <button className={activeTab === 'fields' ? 'active' : ''} onClick={() => setActiveTab('fields')}>
          Fields ({form.fields?.length || 0})
        </button>
        <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}>
          Settings
        </button>
      </div>

      {activeTab === 'fields' ? (
        <FieldsEditor form={form} userId={user.id} onUpdate={() => router.invalidate()} />
      ) : (
        <SettingsEditor form={form} userId={user.id} onUpdate={() => router.invalidate()} />
      )}
    </article>
  )
}

function FieldsEditor({ form, userId, onUpdate }: { form: FormType; userId: string; onUpdate: () => void }) {
  const [showAdd, setShowAdd] = useState(false)
  const [newField, setNewField] = useState({
    type: 'text',
    label: '',
    placeholder: '',
    isRequired: false,
    options: [] as FieldOption[],
  })
  const [adding, setAdding] = useState(false)

  const handleAddField = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newField.label.trim()) return

    setAdding(true)
    try {
      await addField({
        data: {
          formId: form.id,
          userId,
          type: newField.type,
          label: newField.label.trim(),
          placeholder: newField.placeholder || undefined,
          isRequired: newField.isRequired,
          options: ['select', 'radio', 'checkbox'].includes(newField.type) ? newField.options : undefined,
        },
      })
      setNewField({ type: 'text', label: '', placeholder: '', isRequired: false, options: [] })
      setShowAdd(false)
      onUpdate()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add field')
    } finally {
      setAdding(false)
    }
  }

  const handleDeleteField = async (fieldId: string) => {
    if (!confirm('Delete this field?')) return
    await deleteField({ data: { id: fieldId, userId } })
    onUpdate()
  }

  const needsOptions = ['select', 'radio', 'checkbox'].includes(newField.type)

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <button onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? 'Cancel' : '+ Add Field'}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAddField} style={{ background: '#f9fafb', padding: '1rem', borderRadius: '0.5rem', marginBottom: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label>
                Field Type
                <select value={newField.type} onChange={(e) => setNewField({ ...newField, type: e.target.value, options: [] })}>
                  {FIELD_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div>
              <label>
                Label *
                <input
                  type="text"
                  placeholder="e.g., Your Name"
                  value={newField.label}
                  onChange={(e) => setNewField({ ...newField, label: e.target.value })}
                  required
                />
              </label>
            </div>
          </div>
          <label>
            Placeholder
            <input
              type="text"
              placeholder="e.g., Enter your name"
              value={newField.placeholder}
              onChange={(e) => setNewField({ ...newField, placeholder: e.target.value })}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={newField.isRequired}
              onChange={(e) => setNewField({ ...newField, isRequired: e.target.checked })}
              style={{ width: 'auto', marginBottom: 0 }}
            />
            Required field
          </label>

          {needsOptions && (
            <div style={{ marginTop: '1rem' }}>
              <label>Options</label>
              {newField.options.map((opt, i) => (
                <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <input
                    type="text"
                    placeholder="Option label"
                    value={opt.label}
                    onChange={(e) => {
                      const options = [...newField.options]
                      options[i] = { ...options[i], label: e.target.value, value: e.target.value.toLowerCase().replace(/\s+/g, '_') }
                      setNewField({ ...newField, options })
                    }}
                    style={{ marginBottom: 0 }}
                  />
                  <button
                    type="button"
                    className="outline secondary"
                    onClick={() => {
                      const options = newField.options.filter((_, idx) => idx !== i)
                      setNewField({ ...newField, options })
                    }}
                    style={{ marginBottom: 0, padding: '0.25rem 0.5rem' }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="outline"
                onClick={() => setNewField({ ...newField, options: [...newField.options, { value: '', label: '' }] })}
                style={{ fontSize: '0.875rem' }}
              >
                + Add Option
              </button>
            </div>
          )}

          <button type="submit" disabled={adding || !newField.label.trim()} style={{ marginTop: '1rem' }}>
            {adding ? 'Adding...' : 'Add Field'}
          </button>
        </form>
      )}

      {/* Fields list */}
      {form.fields && form.fields.length > 0 ? (
        <div>
          {form.fields.map((field, index) => {
            const fieldType = FIELD_TYPES.find((t) => t.value === field.type)
            const options = parseFieldOptions(field.options)

            return (
              <div key={field.id} className="field-card">
                <span className="drag-handle">⋮⋮</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <strong>{field.label}</strong>
                    {field.isRequired && <span style={{ color: '#ef4444' }}>*</span>}
                    <span className="field-type-badge">{fieldType?.label || field.type}</span>
                  </div>
                  {field.placeholder && (
                    <p style={{ fontSize: '0.75rem', color: '#9ca3af', margin: '0.25rem 0 0' }}>
                      Placeholder: {field.placeholder}
                    </p>
                  )}
                  {options.length > 0 && (
                    <p style={{ fontSize: '0.75rem', color: '#9ca3af', margin: '0.25rem 0 0' }}>
                      Options: {options.map((o) => o.label).join(', ')}
                    </p>
                  )}
                </div>
                <button
                  className="outline secondary"
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                  onClick={() => handleDeleteField(field.id)}
                >
                  Delete
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '2rem', color: '#666', background: '#f9fafb', borderRadius: '0.5rem' }}>
          <p>No fields yet. Add your first field above!</p>
        </div>
      )}
    </div>
  )
}

function SettingsEditor({ form, userId, onUpdate }: { form: FormType; userId: string; onUpdate: () => void }) {
  const [settings, setSettings] = useState({
    name: form.name,
    description: form.description || '',
    isPublished: form.isPublished,
    isAcceptingResponses: form.isAcceptingResponses,
    primaryColor: form.primaryColor,
    submitButtonText: form.submitButtonText,
    successMessage: form.successMessage,
  })
  const [saving, setSaving] = useState(false)

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await updateForm({
        data: {
          id: form.id,
          userId,
          ...settings,
          description: settings.description || undefined,
        },
      })
      onUpdate()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave}>
      <h3>General</h3>
      <label>
        Form Name
        <input
          type="text"
          value={settings.name}
          onChange={(e) => setSettings({ ...settings, name: e.target.value })}
          required
        />
      </label>
      <label>
        Description
        <textarea
          value={settings.description}
          onChange={(e) => setSettings({ ...settings, description: e.target.value })}
          placeholder="Optional description for your form"
          rows={2}
        />
      </label>

      <h3>Publishing</h3>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input
          type="checkbox"
          checked={settings.isPublished}
          onChange={(e) => setSettings({ ...settings, isPublished: e.target.checked })}
          style={{ width: 'auto', marginBottom: 0 }}
        />
        Published (form is publicly accessible)
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input
          type="checkbox"
          checked={settings.isAcceptingResponses}
          onChange={(e) => setSettings({ ...settings, isAcceptingResponses: e.target.checked })}
          style={{ width: 'auto', marginBottom: 0 }}
        />
        Accepting responses
      </label>

      <h3>Appearance</h3>
      <label>
        Primary Color
        <input
          type="color"
          value={settings.primaryColor}
          onChange={(e) => setSettings({ ...settings, primaryColor: e.target.value })}
          style={{ height: '2.5rem', padding: '0.25rem' }}
        />
      </label>
      <label>
        Submit Button Text
        <input
          type="text"
          value={settings.submitButtonText}
          onChange={(e) => setSettings({ ...settings, submitButtonText: e.target.value })}
        />
      </label>
      <label>
        Success Message
        <textarea
          value={settings.successMessage}
          onChange={(e) => setSettings({ ...settings, successMessage: e.target.value })}
          rows={2}
        />
      </label>

      <button type="submit" disabled={saving}>
        {saving ? 'Saving...' : 'Save Settings'}
      </button>
    </form>
  )
}
