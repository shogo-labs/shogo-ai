// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Form Builder App
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { api, configureApiClient } from './generated/api-client'

interface FieldType {
  id: string
  type: string
  label: string
  placeholder: string | null
  helpText: string | null
  position: number
  isRequired: boolean
  options: string | null
}

interface FormType {
  id: string
  name: string
  description: string | null
  slug: string
  isPublished: boolean
  isAcceptingResponses: boolean
  primaryColor: string
  submitButtonText: string
  successMessage: string
  fields?: FieldType[]
  _count?: { submissions: number }
}

interface SubmissionType {
  id: string
  respondentEmail: string | null
  isRead: boolean
  createdAt: string
  responses?: { fieldId: string; value: string; field?: FieldType }[]
}

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Long Text' },
  { value: 'email', label: 'Email' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Dropdown' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'radio', label: 'Radio' },
  { value: 'rating', label: 'Rating' },
]

export default function App() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/')

  useEffect(() => {
    const handleHash = () => setRoute(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  // Public form page
  if (route.startsWith('/f/')) {
    const slug = route.replace('/f/', '')
    return <PublicFormPage slug={slug} />
  }

  // Protected dashboard
  return (
    <AuthGate>
      <Dashboard route={route} setRoute={setRoute} />
    </AuthGate>
  )
}

const Dashboard = observer(function Dashboard({ route, setRoute }: { route: string; setRoute: (r: string) => void }) {
  const { auth } = useStores()
  const [forms, setForms] = useState<FormType[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingForm, setEditingForm] = useState<FormType | null>(null)
  const [viewingSubmissions, setViewingSubmissions] = useState<{ form: FormType; submissions: SubmissionType[] } | null>(null)

  // Configure API client with user context
  useEffect(() => {
    if (auth.user) {
      configureApiClient({ userId: auth.user.id })
    }
  }, [auth.user?.id])

  const fetchForms = useCallback(async () => {
    if (!auth.user) return
    try {
      const result = await api.form.list()
      if (result.ok) {
        setForms((result.items || []) as any)
      }
    } catch (err) {
      console.error('Failed to fetch forms:', err)
    } finally {
      setLoading(false)
    }
  }, [auth.user])

  useEffect(() => { fetchForms() }, [fetchForms])

  const handleCreateForm = async (name: string, slug: string) => {
    if (!auth.user) return
    try {
      const result = await api.form.create({ name, slug, userId: auth.user.id } as any)
      if (result.ok) {
        setShowAddForm(false)
        fetchForms()
      }
    } catch (err) {
      console.error('Failed to create form:', err)
    }
  }

  const handleDeleteForm = async (id: string) => {
    if (!confirm('Delete this form and all submissions?')) return
    await api.form.delete(id)
    fetchForms()
  }

  const handleEditForm = async (formId: string) => {
    try {
      // Custom endpoint - not covered by generated API client
      const res = await fetch(`/api/forms/${formId}/full`)
      if (res.ok) {
        const form = await res.json()
        setEditingForm(form)
      }
    } catch (err) {
      console.error('Failed to fetch form:', err)
    }
  }

  const handleViewSubmissions = async (form: FormType) => {
    try {
      const result = await api.submission.list({ where: { formId: form.id }, params: { include: 'responses.field' } })
      if (result.ok) {
        setViewingSubmissions({ form, submissions: (result.items || []) as any })
      }
    } catch (err) {
      console.error('Failed to fetch submissions:', err)
    }
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-500">Loading...</p></div>
  }

  // Form editor view
  if (editingForm) {
    return <FormEditor form={editingForm} onBack={() => { setEditingForm(null); fetchForms() }} />
  }

  // Submissions view
  if (viewingSubmissions) {
    return <SubmissionsView data={viewingSubmissions} onBack={() => setViewingSubmissions(null)} />
  }

  // Forms list view
  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">📝 Form Builder</h1>
        <div className="flex items-center gap-4">
          <span className="text-gray-500">{auth.user?.name || auth.user?.email}</span>
          <button onClick={() => auth.signOut()} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Sign Out</button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold text-gray-900">Your Forms</h2>
          <button onClick={() => setShowAddForm(true)} className="px-4 py-2 text-white rounded-lg text-sm font-medium" style={{ backgroundColor: '#ec4899' }}>
            + New Form
          </button>
        </div>

        {showAddForm && <AddFormModal onAdd={handleCreateForm} onCancel={() => setShowAddForm(false)} />}

        {forms.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 mb-4">No forms yet. Create your first form!</p>
          </div>
        ) : (
          <div className="space-y-4">
            {forms.map(form => (
              <div key={form.id} className="bg-white rounded-xl p-5 shadow-sm border-l-4" style={{ borderColor: form.primaryColor }}>
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">{form.name}</h3>
                      <span className={`text-xs px-2 py-0.5 rounded ${form.isPublished ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-500'}`}>
                        {form.isPublished ? 'Published' : 'Draft'}
                      </span>
                    </div>
                    {form.description && <p className="text-sm text-gray-500 mt-1">{form.description}</p>}
                    <div className="flex items-center gap-4 mt-2 text-sm text-gray-400">
                      <span>/{form.slug}</span>
                      <span>{form._count?.submissions || 0} submissions</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => handleEditForm(form.id)} className="px-3 py-1 text-sm border border-gray-200 rounded hover:bg-gray-50">Edit</button>
                    <button onClick={() => handleViewSubmissions(form)} className="px-3 py-1 text-sm border border-gray-200 rounded hover:bg-gray-50">Submissions</button>
                    <button onClick={() => handleDeleteForm(form.id)} className="px-3 py-1 text-sm text-red-500 border border-red-200 rounded hover:bg-red-50">Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <footer className="text-center text-gray-400 text-sm mt-8">Built with @shogo-ai/sdk + Hono</footer>
      </div>
    </div>
  )
})

function AddFormModal({ onAdd, onCancel }: { onAdd: (name: string, slug: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')

  const generateSlug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  return (
    <div className="bg-white rounded-xl p-5 shadow-sm mb-6">
      <h3 className="font-semibold text-gray-900 mb-4">Create New Form</h3>
      <div className="space-y-3">
        <input
          type="text"
          placeholder="Form name"
          value={name}
          onChange={(e) => { setName(e.target.value); setSlug(generateSlug(e.target.value)) }}
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm"
        />
        <div className="flex items-center gap-2">
          <span className="text-gray-500">/f/</span>
          <input
            type="text"
            placeholder="url-slug"
            value={slug}
            onChange={(e) => setSlug(generateSlug(e.target.value))}
            className="flex-1 px-4 py-3 border border-gray-200 rounded-lg text-sm"
          />
        </div>
        <div className="flex gap-2">
          <button onClick={() => name && slug && onAdd(name, slug)} className="px-4 py-2 text-white rounded-lg text-sm" style={{ backgroundColor: '#ec4899' }}>Create</button>
          <button onClick={onCancel} className="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
        </div>
      </div>
    </div>
  )
}

function FormEditor({ form, onBack }: { form: FormType; onBack: () => void }) {
  const [fields, setFields] = useState<FieldType[]>(form.fields || [])
  const [formSettings, setFormSettings] = useState(form)
  const [showAddField, setShowAddField] = useState(false)

  const handleUpdateForm = async (updates: Partial<FormType>) => {
    try {
      await api.form.update(form.id, updates as any)
      setFormSettings({ ...formSettings, ...updates })
    } catch (err) {
      console.error('Failed to update form:', err)
    }
  }

  const handleAddField = async (data: Partial<FieldType>) => {
    try {
      const maxPos = Math.max(0, ...fields.map(f => f.position))
      const result = await api.field.create({ ...data, formId: form.id, position: maxPos + 1 } as any)
      if (result.ok && result.data) {
        setFields([...fields, result.data as FieldType])
        setShowAddField(false)
      }
    } catch (err) {
      console.error('Failed to add field:', err)
    }
  }

  const handleDeleteField = async (fieldId: string) => {
    await api.field.delete(fieldId)
    setFields(fields.filter(f => f.id !== fieldId))
  }

  const publicUrl = `${window.location.origin}/#/f/${form.slug}`

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="text-gray-500 hover:text-gray-700">← Back</button>
          <h1 className="text-xl font-bold text-gray-900">{formSettings.name}</h1>
        </div>
        <div className="flex gap-2">
          {formSettings.isPublished && (
            <a href={publicUrl} target="_blank" className="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Preview →</a>
          )}
          <button
            onClick={() => handleUpdateForm({ isPublished: !formSettings.isPublished })}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${formSettings.isPublished ? 'bg-gray-100 text-gray-600' : 'text-white'}`}
            style={!formSettings.isPublished ? { backgroundColor: '#ec4899' } : {}}
          >
            {formSettings.isPublished ? 'Unpublish' : 'Publish'}
          </button>
        </div>
      </header>

      <div className="max-w-2xl mx-auto p-6">
        {formSettings.isPublished && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
            <p className="text-sm text-green-600">Your form is live! Share this link:</p>
            <code className="text-xs bg-white px-3 py-2 rounded border border-green-200 block mt-2 truncate">{publicUrl}</code>
          </div>
        )}

        <div className="bg-white rounded-xl p-5 shadow-sm mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">Fields</h2>
          {fields.length === 0 ? (
            <p className="text-gray-400 text-center py-4">No fields yet. Add your first field!</p>
          ) : (
            <div className="space-y-3">
              {fields.sort((a, b) => a.position - b.position).map(field => (
                <div key={field.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <span className="font-medium text-gray-900">{field.label}</span>
                    <span className="text-xs text-gray-400 ml-2">{field.type}</span>
                    {field.isRequired && <span className="text-xs text-red-500 ml-2">*</span>}
                  </div>
                  <button onClick={() => handleDeleteField(field.id)} className="text-gray-400 hover:text-red-500">×</button>
                </div>
              ))}
            </div>
          )}
          {showAddField ? (
            <AddFieldForm onAdd={handleAddField} onCancel={() => setShowAddField(false)} />
          ) : (
            <button onClick={() => setShowAddField(true)} className="mt-4 w-full p-3 border border-dashed border-gray-300 rounded-lg text-gray-400 text-sm hover:border-gray-400">
              + Add Field
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function AddFieldForm({ onAdd, onCancel }: { onAdd: (data: Partial<FieldType>) => void; onCancel: () => void }) {
  const [type, setType] = useState('text')
  const [label, setLabel] = useState('')
  const [placeholder, setPlaceholder] = useState('')
  const [isRequired, setIsRequired] = useState(false)

  return (
    <div className="mt-4 p-4 bg-gray-50 rounded-lg">
      <div className="space-y-3">
        <select value={type} onChange={(e) => setType(e.target.value)} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm bg-white">
          {FIELD_TYPES.map(ft => <option key={ft.value} value={ft.value}>{ft.label}</option>)}
        </select>
        <input type="text" placeholder="Label *" value={label} onChange={(e) => setLabel(e.target.value)} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
        <input type="text" placeholder="Placeholder" value={placeholder} onChange={(e) => setPlaceholder(e.target.value)} className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm" />
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
          Required
        </label>
        <div className="flex gap-2">
          <button onClick={() => label && onAdd({ type, label, placeholder: placeholder || null, isRequired })} className="px-4 py-2 text-white rounded-lg text-sm" style={{ backgroundColor: '#ec4899' }}>Add Field</button>
          <button onClick={onCancel} className="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
        </div>
      </div>
    </div>
  )
}

function SubmissionsView({ data, onBack }: { data: { form: FormType; submissions: SubmissionType[] }; onBack: () => void }) {
  const { form, submissions } = data

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-4">
        <button onClick={onBack} className="text-gray-500 hover:text-gray-700">← Back</button>
        <h1 className="text-xl font-bold text-gray-900">{form.name} - Submissions</h1>
        <span className="text-gray-400">({submissions.length})</span>
      </header>

      <div className="max-w-4xl mx-auto p-6">
        {submissions.length === 0 ? (
          <p className="text-gray-400 text-center py-12">No submissions yet.</p>
        ) : (
          <div className="space-y-4">
            {submissions.map(sub => (
              <div key={sub.id} className="bg-white rounded-xl p-5 shadow-sm">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <span className="text-sm text-gray-500">{new Date(sub.createdAt).toLocaleString()}</span>
                    {sub.respondentEmail && <span className="text-sm text-gray-600 ml-4">{sub.respondentEmail}</span>}
                  </div>
                  {!sub.isRead && <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-600">New</span>}
                </div>
                <div className="space-y-2">
                  {sub.responses?.map(resp => (
                    <div key={resp.fieldId} className="text-sm">
                      <span className="text-gray-500">{resp.field?.label || 'Field'}:</span>
                      <span className="text-gray-900 ml-2">{resp.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PublicFormPage({ slug }: { slug: string }) {
  const [form, setForm] = useState<FormType | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/forms/slug/${slug}`)
        if (res.ok) {
          const f = await res.json()
          if (!f.isPublished || !f.isAcceptingResponses) {
            setError('This form is not accepting responses.')
          } else {
            setForm(f)
          }
        } else {
          setError('Form not found')
        }
      } catch (err) {
        setError('Failed to load form')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [slug])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form) return
    setSubmitting(true)

    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formId: form.id, responses: values }),
      })
      if (res.ok) {
        setSuccess(true)
      } else {
        const data = await res.json()
        setError(data.error || 'Submission failed')
      }
    } catch (err) {
      setError('Submission failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center"><p className="text-gray-500">Loading...</p></div>
  if (error) return <div className="min-h-screen flex items-center justify-center"><p className="text-red-500">{error}</p></div>
  if (!form) return null

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: `linear-gradient(135deg, ${form.primaryColor} 0%, ${form.primaryColor}aa 100%)` }}>
        <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md text-center">
          <div className="text-4xl mb-4">✅</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Thank You!</h1>
          <p className="text-gray-500">{form.successMessage}</p>
        </div>
      </div>
    )
  }

  const fields = (form.fields || []).sort((a, b) => a.position - b.position)

  return (
    <div className="min-h-screen p-4" style={{ background: `linear-gradient(135deg, ${form.primaryColor} 0%, ${form.primaryColor}aa 100%)` }}>
      <div className="max-w-md mx-auto">
        <div className="bg-white rounded-xl shadow-lg p-6">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">{form.name}</h1>
          {form.description && <p className="text-gray-500 mb-4">{form.description}</p>}

          <form onSubmit={handleSubmit} className="space-y-4">
            {fields.map(field => (
              <div key={field.id}>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {field.label}
                  {field.isRequired && <span className="text-red-500 ml-1">*</span>}
                </label>
                {field.helpText && <p className="text-xs text-gray-400 mb-1">{field.helpText}</p>}
                {renderField(field, values[field.id] || '', (v) => setValues({ ...values, [field.id]: v }))}
              </div>
            ))}
            <button
              type="submit"
              disabled={submitting}
              className="w-full px-4 py-3 text-white rounded-lg font-medium disabled:opacity-50"
              style={{ backgroundColor: form.primaryColor }}
            >
              {submitting ? 'Submitting...' : form.submitButtonText}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

function renderField(field: FieldType, value: string, onChange: (v: string) => void) {
  const baseClass = "w-full px-4 py-3 border border-gray-200 rounded-lg text-sm"

  switch (field.type) {
    case 'textarea':
      return <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder || ''} required={field.isRequired} rows={4} className={baseClass} />
    case 'email':
      return <input type="email" value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder || ''} required={field.isRequired} className={baseClass} />
    case 'number':
      return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder || ''} required={field.isRequired} className={baseClass} />
    case 'date':
      return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} required={field.isRequired} className={baseClass} />
    case 'select':
      const opts = field.options ? JSON.parse(field.options) : []
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} required={field.isRequired} className={`${baseClass} bg-white`}>
          <option value="">{field.placeholder || 'Select...'}</option>
          {opts.map((o: { value: string; label: string }) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )
    case 'checkbox':
      return <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} />
    case 'rating':
      return (
        <div className="flex gap-2">
          {[1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(String(n))}
              className={`w-10 h-10 rounded ${parseInt(value) >= n ? 'bg-yellow-400' : 'bg-gray-200'}`}
            >
              ★
            </button>
          ))}
        </div>
      )
    default:
      return <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder || ''} required={field.isRequired} className={baseClass} />
  }
}
