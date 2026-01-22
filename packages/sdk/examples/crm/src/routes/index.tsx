import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { createUser, type UserType } from '../utils/user'
import { getContacts, createContact, updateContact, deleteContact, getContactStats, type ContactType } from '../utils/contacts'
import { getCompanies, createCompany, type CompanyType } from '../utils/companies'
import { getTags, type TagType } from '../utils/tags'
import { getNotes, createNote, type NoteType } from '../utils/notes'
import { getDealPipeline } from '../utils/deals'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    if (!context.user) {
      return {
        contacts: [] as ContactType[],
        companies: [] as CompanyType[],
        tags: [] as TagType[],
        stats: null,
        pipeline: null,
      }
    }

    const [contacts, companies, tags, stats, pipeline] = await Promise.all([
      getContacts({ data: { userId: context.user.id } }),
      getCompanies({ data: { userId: context.user.id } }),
      getTags({ data: { userId: context.user.id } }),
      getContactStats({ data: { userId: context.user.id } }),
      getDealPipeline({ data: { userId: context.user.id } }),
    ])

    return { contacts, companies, tags, stats, pipeline }
  },
  component: CRMApp,
})

function CRMApp() {
  const { user } = Route.useRouteContext()
  const data = Route.useLoaderData()
  const router = useRouter()

  if (!user) {
    return <SetupForm onComplete={() => router.invalidate()} />
  }

  return (
    <Dashboard
      user={user}
      contacts={data.contacts}
      companies={data.companies}
      tags={data.tags}
      stats={data.stats!}
      pipeline={data.pipeline!}
    />
  )
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
      setError(err instanceof Error ? err.message : 'Failed to create account')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <div className="setup-container">
        <div className="setup-card">
          <h1>CRM</h1>
          <p>Manage your contacts, companies, and deals.</p>

          <form onSubmit={handleSubmit} className="form">
            <div className="form-group">
              <label>Email address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="input"
                placeholder="you@company.com"
              />
            </div>
            <div className="form-group">
              <label>Name (optional)</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input"
                placeholder="Your name"
              />
            </div>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%' }}>
              {loading ? 'Setting up...' : 'Get Started'}
            </button>
          </form>

          <p className="setup-footer">
            Built with TanStack Start + Prisma
          </p>
        </div>
      </div>
    </div>
  )
}

type StatsType = {
  total: number
  leads: number
  prospects: number
  customers: number
  churned: number
}

type PipelineType = {
  pipeline: Array<{ stage: string; count: number; value: number }>
  totalValue: number
  wonValue: number
}

function Dashboard({
  user,
  contacts,
  companies,
  tags,
  stats,
  pipeline,
}: {
  user: UserType
  contacts: ContactType[]
  companies: CompanyType[]
  tags: TagType[]
  stats: StatsType
  pipeline: PipelineType
}) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'contacts' | 'pipeline'>('contacts')
  const [showAddContact, setShowAddContact] = useState(false)
  const [selectedContact, setSelectedContact] = useState<ContactType | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')

  // Filter contacts client-side for responsiveness
  const filteredContacts = contacts.filter(contact => {
    if (statusFilter && contact.status !== statusFilter) return false
    if (tagFilter && !contact.tags?.some(t => t.tag.id === tagFilter)) return false
    if (search) {
      const searchLower = search.toLowerCase()
      const fullName = `${contact.firstName} ${contact.lastName}`.toLowerCase()
      const email = contact.email?.toLowerCase() ?? ''
      const company = contact.company?.name.toLowerCase() ?? ''
      if (!fullName.includes(searchLower) && !email.includes(searchLower) && !company.includes(searchLower)) {
        return false
      }
    }
    return true
  })

  return (
    <div className="app">
      <header className="header">
        <h1>CRM</h1>
        <div className="user-info">{user.name || user.email}</div>
      </header>

      <div className="main-content">
        {/* Stats */}
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Total Contacts</div>
            <div className="stat-value">{stats.total}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Leads</div>
            <div className="stat-value" style={{ color: '#f59e0b' }}>{stats.leads}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Customers</div>
            <div className="stat-value" style={{ color: '#22c55e' }}>{stats.customers}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Pipeline Value</div>
            <div className="stat-value" style={{ color: '#3b82f6' }}>${pipeline.totalValue.toLocaleString()}</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="tabs">
          <button
            className={`tab ${activeTab === 'contacts' ? 'active' : ''}`}
            onClick={() => setActiveTab('contacts')}
          >
            Contacts
          </button>
          <button
            className={`tab ${activeTab === 'pipeline' ? 'active' : ''}`}
            onClick={() => setActiveTab('pipeline')}
          >
            Pipeline
          </button>
        </div>

        {activeTab === 'contacts' && (
          <div className="section">
            <div className="section-header">
              <h2>Contacts</h2>
              <button className="btn btn-primary" onClick={() => setShowAddContact(true)}>
                + Add Contact
              </button>
            </div>
            <div className="section-body">
              {/* Filters */}
              <div className="filters">
                <input
                  type="text"
                  placeholder="Search contacts..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="search-input"
                />
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="filter-select"
                >
                  <option value="">All Statuses</option>
                  <option value="lead">Lead</option>
                  <option value="prospect">Prospect</option>
                  <option value="customer">Customer</option>
                  <option value="churned">Churned</option>
                </select>
                <select
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                  className="filter-select"
                >
                  <option value="">All Tags</option>
                  {tags.map(tag => (
                    <option key={tag.id} value={tag.id}>{tag.name}</option>
                  ))}
                </select>
              </div>

              {/* Contact List */}
              {filteredContacts.length === 0 ? (
                <div className="empty">
                  <div className="empty-icon">👤</div>
                  <p>{contacts.length === 0 ? 'No contacts yet. Add your first contact!' : 'No contacts match your filters.'}</p>
                </div>
              ) : (
                <div className="contact-list">
                  {filteredContacts.map(contact => (
                    <div
                      key={contact.id}
                      className="contact-item"
                      onClick={() => setSelectedContact(contact)}
                    >
                      <div className="contact-avatar">
                        {contact.firstName[0]}{contact.lastName[0]}
                      </div>
                      <div className="contact-info">
                        <div className="contact-name">
                          {contact.firstName} {contact.lastName}
                        </div>
                        <div className="contact-details">
                          {contact.email && <span>{contact.email}</span>}
                          {contact.company && <span>{contact.company.name}</span>}
                        </div>
                        {contact.tags && contact.tags.length > 0 && (
                          <div className="contact-tags" style={{ marginTop: '8px' }}>
                            {contact.tags.map(({ tag }) => (
                              <span
                                key={tag.id}
                                className="tag"
                                style={{ backgroundColor: tag.color + '20', color: tag.color }}
                              >
                                {tag.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className={`status-badge status-${contact.status}`}>
                        {contact.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'pipeline' && (
          <div className="section">
            <div className="section-header">
              <h2>Deal Pipeline</h2>
            </div>
            <div className="section-body">
              <div className="pipeline-grid">
                {pipeline.pipeline.map(stage => (
                  <div key={stage.stage} className="pipeline-stage">
                    <div className="pipeline-stage-name">{stage.stage}</div>
                    <div className="pipeline-stage-count">{stage.count}</div>
                    <div className="pipeline-stage-value">${stage.value.toLocaleString()}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: '24px', textAlign: 'center' }}>
                <div style={{ color: '#64748b', marginBottom: '8px' }}>Total Won</div>
                <div style={{ fontSize: '2rem', fontWeight: '700', color: '#22c55e' }}>
                  ${pipeline.wonValue.toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Add Contact Modal */}
      {showAddContact && (
        <AddContactModal
          userId={user.id}
          companies={companies}
          tags={tags}
          onClose={() => setShowAddContact(false)}
          onSave={() => {
            setShowAddContact(false)
            router.invalidate()
          }}
        />
      )}

      {/* Contact Detail Modal */}
      {selectedContact && (
        <ContactDetailModal
          contact={selectedContact}
          userId={user.id}
          companies={companies}
          tags={tags}
          onClose={() => setSelectedContact(null)}
          onUpdate={() => {
            setSelectedContact(null)
            router.invalidate()
          }}
        />
      )}
    </div>
  )
}

function AddContactModal({
  userId,
  companies,
  tags,
  onClose,
  onSave,
}: {
  userId: string
  companies: CompanyType[]
  tags: TagType[]
  onClose: () => void
  onSave: () => void
}) {
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    title: '',
    status: 'lead',
    source: '',
    companyId: '',
  })
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showNewCompany, setShowNewCompany] = useState(false)
  const [newCompanyName, setNewCompanyName] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.firstName || !formData.lastName) return

    setLoading(true)
    setError('')

    try {
      // Create company first if needed
      let companyId = formData.companyId || undefined
      if (showNewCompany && newCompanyName) {
        const company = await createCompany({
          data: { name: newCompanyName, userId },
        })
        companyId = company.id
      }

      await createContact({
        data: {
          ...formData,
          companyId,
          tagIds: selectedTags.length > 0 ? selectedTags : undefined,
          userId,
        },
      })
      onSave()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create contact')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Add Contact</h3>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form">
              <div className="form-row">
                <div className="form-group">
                  <label>First Name *</label>
                  <input
                    type="text"
                    value={formData.firstName}
                    onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                    required
                    className="input"
                  />
                </div>
                <div className="form-group">
                  <label>Last Name *</label>
                  <input
                    type="text"
                    value={formData.lastName}
                    onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                    required
                    className="input"
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="input"
                  />
                </div>
                <div className="form-group">
                  <label>Phone</label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="input"
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Job Title</label>
                  <input
                    type="text"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    className="input"
                  />
                </div>
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                    className="input"
                  >
                    <option value="lead">Lead</option>
                    <option value="prospect">Prospect</option>
                    <option value="customer">Customer</option>
                    <option value="churned">Churned</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Company</label>
                  {!showNewCompany ? (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <select
                        value={formData.companyId}
                        onChange={(e) => setFormData({ ...formData, companyId: e.target.value })}
                        className="input"
                        style={{ flex: 1 }}
                      >
                        <option value="">No Company</option>
                        {companies.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setShowNewCompany(true)}
                      >
                        + New
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="text"
                        value={newCompanyName}
                        onChange={(e) => setNewCompanyName(e.target.value)}
                        placeholder="New company name"
                        className="input"
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setShowNewCompany(false)
                          setNewCompanyName('')
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label>Source</label>
                  <select
                    value={formData.source}
                    onChange={(e) => setFormData({ ...formData, source: e.target.value })}
                    className="input"
                  >
                    <option value="">Select source</option>
                    <option value="website">Website</option>
                    <option value="referral">Referral</option>
                    <option value="cold_call">Cold Call</option>
                    <option value="event">Event</option>
                    <option value="social">Social Media</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Tags</label>
                <div className="tag-input-container">
                  {tags.filter(t => selectedTags.includes(t.id)).map(tag => (
                    <span
                      key={tag.id}
                      className="tag-input-tag"
                      style={{ backgroundColor: tag.color + '20', color: tag.color }}
                    >
                      {tag.name}
                      <button type="button" onClick={() => setSelectedTags(selectedTags.filter(id => id !== tag.id))}>
                        ×
                      </button>
                    </span>
                  ))}
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value && !selectedTags.includes(e.target.value)) {
                        setSelectedTags([...selectedTags, e.target.value])
                      }
                    }}
                    style={{ border: 'none', outline: 'none', flex: 1, minWidth: '100px', fontSize: '0.875rem' }}
                  >
                    <option value="">Add tag...</option>
                    {tags.filter(t => !selectedTags.includes(t.id)).map(tag => (
                      <option key={tag.id} value={tag.id}>{tag.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {error && <p className="error">{error}</p>}
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Creating...' : 'Create Contact'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function ContactDetailModal({
  contact,
  userId,
  companies,
  tags,
  onClose,
  onUpdate,
}: {
  contact: ContactType
  userId: string
  companies: CompanyType[]
  tags: TagType[]
  onClose: () => void
  onUpdate: () => void
}) {
  const [activeTab, setActiveTab] = useState<'details' | 'activity'>('details')
  const [isEditing, setIsEditing] = useState(false)
  const [notes, setNotes] = useState<NoteType[]>([])
  const [newNote, setNewNote] = useState('')
  const [noteType, setNoteType] = useState('note')
  const [loading, setLoading] = useState(false)

  // Load notes
  const loadNotes = async () => {
    try {
      const result = await getNotes({ data: { contactId: contact.id, userId } })
      setNotes(result)
    } catch (err) {
      console.error('Failed to load notes:', err)
    }
  }

  // Load notes when activity tab is shown
  if (activeTab === 'activity' && notes.length === 0) {
    loadNotes()
  }

  const handleAddNote = async () => {
    if (!newNote.trim()) return

    setLoading(true)
    try {
      await createNote({
        data: {
          content: newNote,
          type: noteType,
          contactId: contact.id,
          userId,
        },
      })
      setNewNote('')
      await loadNotes()
    } catch (err) {
      console.error('Failed to add note:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this contact?')) return

    try {
      await deleteContact({ data: { id: contact.id, userId } })
      onUpdate()
    } catch (err) {
      console.error('Failed to delete contact:', err)
    }
  }

  const handleStatusChange = async (newStatus: string) => {
    try {
      await updateContact({
        data: {
          id: contact.id,
          userId,
          status: newStatus,
        },
      })
      onUpdate()
    } catch (err) {
      console.error('Failed to update status:', err)
    }
  }

  const noteIcons: Record<string, string> = {
    note: '📝',
    call: '📞',
    email: '📧',
    meeting: '🤝',
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px' }}>
        <div className="modal-header">
          <div>
            <h3>{contact.firstName} {contact.lastName}</h3>
            {contact.company && (
              <div style={{ fontSize: '0.875rem', color: '#64748b' }}>{contact.company.name}</div>
            )}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>×</button>
        </div>

        <div className="tabs" style={{ padding: '0 20px' }}>
          <button
            className={`tab ${activeTab === 'details' ? 'active' : ''}`}
            onClick={() => setActiveTab('details')}
          >
            Details
          </button>
          <button
            className={`tab ${activeTab === 'activity' ? 'active' : ''}`}
            onClick={() => setActiveTab('activity')}
          >
            Activity ({contact._count?.notes ?? 0})
          </button>
        </div>

        <div className="modal-body">
          {activeTab === 'details' && (
            <div className="form">
              <div className="form-row">
                <div className="form-group">
                  <label>Email</label>
                  <div style={{ padding: '10px 0', color: contact.email ? '#0f172a' : '#94a3b8' }}>
                    {contact.email || 'Not provided'}
                  </div>
                </div>
                <div className="form-group">
                  <label>Phone</label>
                  <div style={{ padding: '10px 0', color: contact.phone ? '#0f172a' : '#94a3b8' }}>
                    {contact.phone || 'Not provided'}
                  </div>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Job Title</label>
                  <div style={{ padding: '10px 0', color: contact.title ? '#0f172a' : '#94a3b8' }}>
                    {contact.title || 'Not provided'}
                  </div>
                </div>
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={contact.status}
                    onChange={(e) => handleStatusChange(e.target.value)}
                    className="input"
                  >
                    <option value="lead">Lead</option>
                    <option value="prospect">Prospect</option>
                    <option value="customer">Customer</option>
                    <option value="churned">Churned</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Tags</label>
                <div className="contact-tags" style={{ padding: '10px 0' }}>
                  {contact.tags && contact.tags.length > 0 ? (
                    contact.tags.map(({ tag }) => (
                      <span
                        key={tag.id}
                        className="tag"
                        style={{ backgroundColor: tag.color + '20', color: tag.color }}
                      >
                        {tag.name}
                      </span>
                    ))
                  ) : (
                    <span style={{ color: '#94a3b8' }}>No tags</span>
                  )}
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Source</label>
                  <div style={{ padding: '10px 0', color: contact.source ? '#0f172a' : '#94a3b8', textTransform: 'capitalize' }}>
                    {contact.source?.replace('_', ' ') || 'Unknown'}
                  </div>
                </div>
                <div className="form-group">
                  <label>Created</label>
                  <div style={{ padding: '10px 0', color: '#64748b' }}>
                    {new Date(contact.createdAt).toLocaleDateString()}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'activity' && (
            <div>
              {/* Add Note Form */}
              <div style={{ marginBottom: '20px', padding: '16px', background: '#f8fafc', borderRadius: '8px' }}>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                  {['note', 'call', 'email', 'meeting'].map(type => (
                    <button
                      key={type}
                      type="button"
                      className={`btn btn-sm ${noteType === type ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setNoteType(type)}
                    >
                      {noteIcons[type]} {type.charAt(0).toUpperCase() + type.slice(1)}
                    </button>
                  ))}
                </div>
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  className="input"
                  rows={3}
                  style={{ width: '100%', resize: 'vertical' }}
                />
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleAddNote}
                  disabled={loading || !newNote.trim()}
                  style={{ marginTop: '8px' }}
                >
                  {loading ? 'Adding...' : 'Add Note'}
                </button>
              </div>

              {/* Activity List */}
              {notes.length === 0 ? (
                <div className="empty">
                  <p>No activity yet. Add a note above!</p>
                </div>
              ) : (
                <div className="activity-list">
                  {notes.map(note => (
                    <div key={note.id} className="activity-item">
                      <div className={`activity-icon ${note.type}`}>
                        {noteIcons[note.type] || '📝'}
                      </div>
                      <div className="activity-content">
                        <div className="activity-text">{note.content}</div>
                        <div className="activity-meta">
                          {note.type.charAt(0).toUpperCase() + note.type.slice(1)} • {new Date(note.createdAt).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-danger" onClick={handleDelete}>
            Delete Contact
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
