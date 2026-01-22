/**
 * Public Form View
 * 
 * The form that respondents fill out.
 * Accessible via the slug URL (e.g., /f/abc123)
 */

import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { getFormBySlug, type FormType } from '../utils/forms'
import { createSubmission } from '../utils/submissions'
import { parseFieldOptions, type FieldOption } from '../utils/fields'

export const Route = createFileRoute('/f/$slug')({
  loader: async ({ params }) => {
    const form = await getFormBySlug({ data: { slug: params.slug } })
    return { form }
  },
  component: PublicForm,
})

function PublicForm() {
  const { form } = Route.useLoaderData()

  if (!form) {
    return (
      <article style={{ maxWidth: '500px', margin: '4rem auto', textAlign: 'center' }}>
        <h1>Form Not Found</h1>
        <p>This form doesn't exist or has been removed.</p>
      </article>
    )
  }

  if (!form.isPublished) {
    return (
      <article style={{ maxWidth: '500px', margin: '4rem auto', textAlign: 'center' }}>
        <h1>Form Not Available</h1>
        <p>This form is not currently published.</p>
      </article>
    )
  }

  if (!form.isAcceptingResponses) {
    return (
      <article style={{ maxWidth: '500px', margin: '4rem auto', textAlign: 'center' }}>
        <h1>{form.name}</h1>
        <p>This form is not currently accepting responses.</p>
      </article>
    )
  }

  return <FormView form={form} />
}

function FormView({ form }: { form: FormType & { user: { name: string | null; email: string } } }) {
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [responses, setResponses] = useState<Record<string, string>>({})

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const responseArray = Object.entries(responses)
        .filter(([_, value]) => value.trim())
        .map(([fieldId, value]) => ({ fieldId, value }))

      await createSubmission({
        data: {
          formId: form.id,
          responses: responseArray,
        },
      })
      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit form')
    } finally {
      setLoading(false)
    }
  }

  const updateResponse = (fieldId: string, value: string) => {
    setResponses((prev) => ({ ...prev, [fieldId]: value }))
  }

  if (submitted) {
    return (
      <article style={{ maxWidth: '500px', margin: '4rem auto', textAlign: 'center' }}>
        <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>✓</div>
        <h1>Thank You!</h1>
        <p>{form.successMessage}</p>
        <button onClick={() => {
          setSubmitted(false)
          setResponses({})
        }}>
          Submit Another Response
        </button>
      </article>
    )
  }

  return (
    <article style={{ maxWidth: '600px', margin: '2rem auto' }}>
      <header style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <h1 style={{ color: form.primaryColor }}>{form.name}</h1>
        {form.description && <p style={{ color: '#666' }}>{form.description}</p>}
      </header>

      <form onSubmit={handleSubmit}>
        {form.fields?.map((field) => (
          <FieldRenderer
            key={field.id}
            field={field}
            value={responses[field.id] || ''}
            onChange={(value) => updateResponse(field.id, value)}
            primaryColor={form.primaryColor}
          />
        ))}

        {error && <p style={{ color: '#e00', fontSize: '0.875rem' }}>{error}</p>}

        <button
          type="submit"
          disabled={loading}
          style={{ backgroundColor: form.primaryColor, borderColor: form.primaryColor }}
        >
          {loading ? 'Submitting...' : form.submitButtonText}
        </button>
      </form>

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: '#666' }}>
        <p>Powered by Form Builder</p>
      </footer>
    </article>
  )
}

function FieldRenderer({
  field,
  value,
  onChange,
  primaryColor,
}: {
  field: any
  value: string
  onChange: (value: string) => void
  primaryColor: string
}) {
  const options = parseFieldOptions(field.options)

  const label = (
    <span>
      {field.label}
      {field.isRequired && <span style={{ color: '#ef4444' }}> *</span>}
    </span>
  )

  switch (field.type) {
    case 'text':
      return (
        <label>
          {label}
          <input
            type="text"
            placeholder={field.placeholder || ''}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={field.isRequired}
          />
          {field.helpText && <small style={{ color: '#666' }}>{field.helpText}</small>}
        </label>
      )

    case 'textarea':
      return (
        <label>
          {label}
          <textarea
            placeholder={field.placeholder || ''}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={field.isRequired}
            rows={4}
          />
          {field.helpText && <small style={{ color: '#666' }}>{field.helpText}</small>}
        </label>
      )

    case 'email':
      return (
        <label>
          {label}
          <input
            type="email"
            placeholder={field.placeholder || 'email@example.com'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={field.isRequired}
          />
          {field.helpText && <small style={{ color: '#666' }}>{field.helpText}</small>}
        </label>
      )

    case 'number':
      return (
        <label>
          {label}
          <input
            type="number"
            placeholder={field.placeholder || ''}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={field.isRequired}
          />
          {field.helpText && <small style={{ color: '#666' }}>{field.helpText}</small>}
        </label>
      )

    case 'date':
      return (
        <label>
          {label}
          <input
            type="date"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={field.isRequired}
          />
          {field.helpText && <small style={{ color: '#666' }}>{field.helpText}</small>}
        </label>
      )

    case 'select':
      return (
        <label>
          {label}
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={field.isRequired}
          >
            <option value="">Select an option</option>
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {field.helpText && <small style={{ color: '#666' }}>{field.helpText}</small>}
        </label>
      )

    case 'radio':
      return (
        <fieldset>
          <legend>{label}</legend>
          {options.map((opt) => (
            <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="radio"
                name={field.id}
                value={opt.value}
                checked={value === opt.value}
                onChange={(e) => onChange(e.target.value)}
                required={field.isRequired}
                style={{ width: 'auto', marginBottom: 0 }}
              />
              {opt.label}
            </label>
          ))}
          {field.helpText && <small style={{ color: '#666' }}>{field.helpText}</small>}
        </fieldset>
      )

    case 'checkbox':
      // For checkbox, store selected values as comma-separated string
      const selectedValues = value ? value.split(',') : []
      return (
        <fieldset>
          <legend>{label}</legend>
          {options.map((opt) => (
            <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="checkbox"
                value={opt.value}
                checked={selectedValues.includes(opt.value)}
                onChange={(e) => {
                  const newValues = e.target.checked
                    ? [...selectedValues, opt.value]
                    : selectedValues.filter((v) => v !== opt.value)
                  onChange(newValues.join(','))
                }}
                style={{ width: 'auto', marginBottom: 0 }}
              />
              {opt.label}
            </label>
          ))}
          {field.helpText && <small style={{ color: '#666' }}>{field.helpText}</small>}
        </fieldset>
      )

    case 'rating':
      const rating = parseInt(value) || 0
      return (
        <label>
          {label}
          <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.5rem' }}>
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => onChange(star.toString())}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '1.5rem',
                  cursor: 'pointer',
                  color: rating >= star ? '#fbbf24' : '#d1d5db',
                  padding: 0,
                }}
              >
                ★
              </button>
            ))}
          </div>
          {field.helpText && <small style={{ color: '#666' }}>{field.helpText}</small>}
        </label>
      )

    default:
      return (
        <label>
          {label}
          <input
            type="text"
            placeholder={field.placeholder || ''}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={field.isRequired}
          />
        </label>
      )
  }
}
