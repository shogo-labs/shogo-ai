/**
 * Public Feedback Form
 * 
 * This is the form that respondents fill out.
 * No authentication required - anyone with the link can submit.
 * 
 * Demonstrates:
 * - Public routes (no auth)
 * - Form submission via shogo.db.submission.create()
 */

import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { getUserById, type UserType } from '../utils/user'
import { createSubmission } from '../utils/submissions'

export const Route = createFileRoute('/form/$userId')({
  loader: async ({ params }) => {
    const user = await getUserById({ data: { userId: params.userId } })
    return { formOwner: user }
  },
  component: PublicFeedbackForm,
})

function PublicFeedbackForm() {
  const { formOwner } = Route.useLoaderData()
  const { userId } = Route.useParams()

  if (!formOwner) {
    return (
      <article style={{ maxWidth: '500px', margin: '4rem auto', textAlign: 'center' }}>
        <h1>Form Not Found</h1>
        <p>This feedback form doesn't exist or has been removed.</p>
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
      await createSubmission({
        data: {
          userId,
          name,
          email,
          rating,
          category,
          message,
          wouldRecommend,
        },
      })
      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit feedback')
    } finally {
      setLoading(false)
    }
  }

  if (submitted) {
    return (
      <article style={{ maxWidth: '500px', margin: '4rem auto', textAlign: 'center' }}>
        <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>✓</div>
        <h1>Thank You!</h1>
        <p>Your feedback has been submitted successfully.</p>
        <button onClick={() => {
          setSubmitted(false)
          setName('')
          setEmail('')
          setRating(0)
          setCategory('feedback')
          setMessage('')
          setWouldRecommend(false)
        }}>
          Submit Another Response
        </button>
      </article>
    )
  }

  return (
    <article style={{ maxWidth: '500px', margin: '2rem auto' }}>
      <header style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <h1>Share Your Feedback</h1>
        <p style={{ color: '#666' }}>for {ownerName}</p>
      </header>

      <form onSubmit={handleSubmit}>
        {/* Name */}
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

        {/* Email */}
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

        {/* Rating */}
        <label>
          Rating *
          <div className="star-rating" style={{ marginTop: '0.5rem' }}>
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

        {/* Category */}
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="feedback">General Feedback</option>
            <option value="bug">Bug Report</option>
            <option value="feature">Feature Request</option>
            <option value="question">Question</option>
          </select>
        </label>

        {/* Message */}
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

        {/* Would Recommend */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={wouldRecommend}
            onChange={(e) => setWouldRecommend(e.target.checked)}
            style={{ width: 'auto', marginBottom: 0 }}
          />
          Would you recommend us to others?
        </label>

        {error && <p style={{ color: '#e00', fontSize: '0.875rem' }}>{error}</p>}

        <button type="submit" disabled={loading}>
          {loading ? 'Submitting...' : 'Submit Feedback'}
        </button>
      </form>

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: '#666' }}>
        <p>Powered by Shogo SDK</p>
      </footer>
    </article>
  )
}
