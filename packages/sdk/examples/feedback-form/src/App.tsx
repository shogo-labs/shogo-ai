/**
 * Feedback Form App
 * 
 * Uses Hono API routes and MobX for state management.
 * Supports both authenticated dashboard and public form pages.
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'

// Types
interface SubmissionType {
  id: string
  name: string
  email: string
  rating: number
  category: string
  message: string
  wouldRecommend: boolean
  isRead: boolean
  isStarred: boolean
  userId: string
  createdAt: string
  updatedAt: string
}

interface SubmissionStats {
  total: number
  unread: number
  starred: number
  averageRating: number
  recommendRate: number
}

interface User {
  id: string
  email: string
  name: string | null
}

export default function App() {
  // Simple hash-based routing for public form
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/')

  useEffect(() => {
    const handleHash = () => setRoute(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  // Check if this is a public form route
  if (route.startsWith('/form/')) {
    const userId = route.replace('/form/', '')
    return <PublicFormPage userId={userId} />
  }

  // Protected dashboard
  return (
    <AuthGate>
      <DashboardPage />
    </AuthGate>
  )
}

// =============================================================================
// Dashboard Page (authenticated)
// =============================================================================

const DashboardPage = observer(function DashboardPage() {
  const { auth } = useStores()
  const [submissions, setSubmissions] = useState<SubmissionType[]>([])
  const [stats, setStats] = useState<SubmissionStats | null>(null)
  const [filter, setFilter] = useState<'all' | 'unread' | 'starred'>('all')
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    if (!auth.user) return
    
    try {
      const [subsRes, statsRes] = await Promise.all([
        fetch(`/api/submissions?userId=${auth.user.id}`),
        fetch(`/api/submissions/stats?userId=${auth.user.id}`),
      ])
      
      if (subsRes.ok) {
        const subsData = await subsRes.json()
        // Handle SDK response format: { ok: true, items: [...] }
        setSubmissions(subsData.items || subsData || [])
      }
      if (statsRes.ok) {
        setStats(await statsRes.json())
      }
    } catch (err) {
      console.error('Failed to fetch data:', err)
    } finally {
      setLoading(false)
    }
  }, [auth.user])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleMarkRead = async (id: string, isRead: boolean) => {
    await fetch(`/api/submissions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead }),
    })
    fetchData()
  }

  const handleToggleStar = async (id: string, isStarred: boolean) => {
    await fetch(`/api/submissions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isStarred }),
    })
    fetchData()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this submission?')) return
    await fetch(`/api/submissions/${id}`, { method: 'DELETE' })
    fetchData()
  }

  const filteredSubmissions = submissions.filter(s => {
    if (filter === 'unread') return !s.isRead
    if (filter === 'starred') return s.isStarred
    return true
  })

  const formUrl = typeof window !== 'undefined' 
    ? `${window.location.origin}/#/form/${auth.user?.id}`
    : `/#/form/${auth.user?.id}`

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem' }}>
        <p>Loading...</p>
      </div>
    )
  }

  return (
    <div>
      <header style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Feedback Dashboard</h1>
            <p style={{ color: '#6b7280' }}>{auth.user?.name || auth.user?.email}</p>
          </div>
          <button
            onClick={() => auth.signOut()}
            style={{ background: '#f3f4f6', color: '#374151' }}
          >
            Sign Out
          </button>
        </div>
        
        {/* Share form link */}
        <div style={{ background: '#eff6ff', padding: '1rem', borderRadius: '8px', marginTop: '1rem' }}>
          <p style={{ fontWeight: 500, marginBottom: '0.5rem' }}>Share your feedback form:</p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input 
              type="text" 
              value={formUrl} 
              readOnly 
              style={{ flex: 1, marginBottom: 0 }}
            />
            <button onClick={() => navigator.clipboard.writeText(formUrl)}>
              Copy
            </button>
            <button 
              onClick={() => window.location.hash = `/form/${auth.user?.id}`}
              style={{ background: 'white', color: '#374151', border: '1px solid #d1d5db' }}
            >
              Preview
            </button>
          </div>
        </div>
      </header>

      {/* Stats */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '2rem' }}>
          <StatCard label="Total" value={stats.total} />
          <StatCard label="Unread" value={stats.unread} />
          <StatCard label="Avg Rating" value={stats.averageRating} />
          <StatCard label="Would Recommend" value={`${stats.recommendRate}%`} />
        </div>
      )}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        {(['all', 'unread', 'starred'] as const).map((f) => (
          <button 
            key={f}
            onClick={() => setFilter(f)}
            style={{
              background: filter === f ? '#3b82f6' : 'white',
              color: filter === f ? 'white' : '#374151',
              border: filter === f ? 'none' : '1px solid #d1d5db',
            }}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)} ({
              f === 'all' ? submissions.length :
              f === 'unread' ? submissions.filter(s => !s.isRead).length :
              submissions.filter(s => s.isStarred).length
            })
          </button>
        ))}
      </div>

      {/* Submissions list */}
      {filteredSubmissions.length === 0 ? (
        <p style={{ textAlign: 'center', color: '#9ca3af', padding: '2rem' }}>
          {submissions.length === 0 
            ? 'No submissions yet. Share your form link to start collecting feedback!'
            : 'No submissions match the current filter.'}
        </p>
      ) : (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
          {filteredSubmissions.map((submission, i) => (
            <div 
              key={submission.id} 
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '1rem',
                padding: '1rem',
                borderBottom: i < filteredSubmissions.length - 1 ? '1px solid #f3f4f6' : 'none',
                background: !submission.isRead ? '#eff6ff' : 'white',
              }}
            >
              {/* Star button */}
              <button
                onClick={() => handleToggleStar(submission.id, !submission.isStarred)}
                style={{
                  background: 'none',
                  padding: '0.25rem',
                  fontSize: '1.25rem',
                  color: submission.isStarred ? '#fbbf24' : '#d1d5db',
                }}
              >
                ★
              </button>

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <strong>{submission.name}</strong>
                  <span style={{
                    padding: '0.125rem 0.5rem',
                    borderRadius: '9999px',
                    fontSize: '0.75rem',
                    fontWeight: 500,
                    background: 
                      submission.category === 'feedback' ? '#dbeafe' :
                      submission.category === 'bug' ? '#fee2e2' :
                      submission.category === 'feature' ? '#dcfce7' :
                      '#fef3c7',
                    color:
                      submission.category === 'feedback' ? '#1e40af' :
                      submission.category === 'bug' ? '#991b1b' :
                      submission.category === 'feature' ? '#166534' :
                      '#92400e',
                  }}>
                    {submission.category}
                  </span>
                  <span style={{ color: '#9ca3af', fontSize: '0.875rem' }}>
                    {'★'.repeat(submission.rating)}{'☆'.repeat(5 - submission.rating)}
                  </span>
                </div>
                <p style={{ color: '#4b5563', fontSize: '0.875rem', marginBottom: '0.25rem' }} className="line-clamp-2">
                  {submission.message}
                </p>
                <p style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                  {submission.email} · {new Date(submission.createdAt).toLocaleDateString()}
                  {submission.wouldRecommend && ' · Would recommend'}
                </p>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => handleMarkRead(submission.id, !submission.isRead)}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', background: 'white', color: '#374151', border: '1px solid #d1d5db' }}
                >
                  {submission.isRead ? 'Mark Unread' : 'Mark Read'}
                </button>
                <button
                  onClick={() => handleDelete(submission.id)}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', background: 'white', color: '#374151', border: '1px solid #d1d5db' }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.875rem', color: '#9ca3af' }}>
        <p>Built with <strong>@shogo-ai/sdk</strong> + Hono</p>
      </footer>
    </div>
  )
})

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: '#f9fafb', borderRadius: '8px', padding: '1rem', textAlign: 'center' }}>
      <p style={{ fontSize: '1.5rem', fontWeight: 700 }}>{value}</p>
      <p style={{ fontSize: '0.875rem', color: '#6b7280' }}>{label}</p>
    </div>
  )
}

// =============================================================================
// Public Form Page (no auth required)
// =============================================================================

function PublicFormPage({ userId }: { userId: string }) {
  const [formOwner, setFormOwner] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then(res => {
        if (!res.ok) {
          setNotFound(true)
          return null
        }
        return res.json()
      })
      .then(user => {
        if (user) setFormOwner(user)
      })
      .finally(() => setLoading(false))
  }, [userId])

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem' }}>
        <p>Loading...</p>
      </div>
    )
  }

  if (notFound || !formOwner) {
    return (
      <article style={{ maxWidth: '500px', margin: '4rem auto', textAlign: 'center' }}>
        <h1>Form Not Found</h1>
        <p>This feedback form doesn't exist or has been removed.</p>
        <button onClick={() => window.location.hash = '/'} style={{ marginTop: '1rem' }}>
          Go to Dashboard
        </button>
      </article>
    )
  }

  return <FeedbackForm userId={userId} ownerName={formOwner.name || formOwner.email} />
}

function FeedbackForm({ userId, ownerName }: { userId: string; ownerName: string }) {
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Form fields
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [rating, setRating] = useState(0)
  const [category, setCategory] = useState('feedback')
  const [message, setMessage] = useState('')
  const [wouldRecommend, setWouldRecommend] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !email || !rating || !message) {
      setError('Please fill in all required fields')
      return
    }

    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          name,
          email,
          rating,
          category,
          message,
          wouldRecommend,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to submit feedback')
      }

      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit feedback')
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setSubmitted(false)
    setName('')
    setEmail('')
    setRating(0)
    setCategory('feedback')
    setMessage('')
    setWouldRecommend(false)
  }

  if (submitted) {
    return (
      <article style={{ maxWidth: '500px', margin: '4rem auto', textAlign: 'center' }}>
        <div style={{ fontSize: '4rem', marginBottom: '1rem', color: '#22c55e' }}>✓</div>
        <h1>Thank You!</h1>
        <p>Your feedback has been submitted successfully.</p>
        <button onClick={resetForm} style={{ marginTop: '1rem' }}>
          Submit Another Response
        </button>
      </article>
    )
  }

  return (
    <article style={{ maxWidth: '500px', margin: '2rem auto' }}>
      <header style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <h1>Share Your Feedback</h1>
        <p style={{ color: '#6b7280' }}>for {ownerName}</p>
      </header>

      <form onSubmit={handleSubmit}>
        <label>
          Your Name *
          <input
            type="text"
            placeholder="John Doe"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>

        <label>
          Your Email *
          <input
            type="email"
            placeholder="john@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label>
          Rating *
          <div className="star-rating" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                className={rating >= star ? 'filled' : ''}
                onClick={() => setRating(star)}
              >
                ★
              </button>
            ))}
          </div>
        </label>

        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="feedback">General Feedback</option>
            <option value="bug">Bug Report</option>
            <option value="feature">Feature Request</option>
            <option value="question">Question</option>
          </select>
        </label>

        <label>
          Your Message *
          <textarea
            placeholder="Tell us what you think..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            required
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '1rem' }}>
          <input
            type="checkbox"
            checked={wouldRecommend}
            onChange={(e) => setWouldRecommend(e.target.checked)}
            style={{ width: 'auto', marginBottom: 0 }}
          />
          Would you recommend us to others?
        </label>

        {error && <p style={{ color: '#dc2626', fontSize: '0.875rem', marginBottom: '1rem' }}>{error}</p>}

        <button type="submit" disabled={loading} style={{ width: '100%' }}>
          {loading ? 'Submitting...' : 'Submit Feedback'}
        </button>
      </form>

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: '#6b7280' }}>
        <p>Powered by Shogo SDK</p>
        <button 
          onClick={() => window.location.hash = '/'}
          style={{ marginTop: '0.5rem', background: 'transparent', color: '#3b82f6', padding: '0.25rem' }}
        >
          Back to Dashboard
        </button>
      </footer>
    </article>
  )
}
