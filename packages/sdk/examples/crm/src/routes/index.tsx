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
    <div className="min-h-screen flex items-center justify-center p-5">
      <div className="bg-white rounded-xl shadow-lg p-10 w-full max-w-md text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">CRM</h1>
        <p className="text-gray-500 mb-6">Manage your contacts, companies, and deals.</p>

        <form onSubmit={handleSubmit} className="space-y-4 text-left">
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Email address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@company.com"
              className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Name (optional)</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {loading ? 'Setting up...' : 'Get Started'}
          </button>
        </form>

        <p className="mt-6 text-xs text-gray-400">Built with TanStack Start + Prisma</p>
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
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">CRM</h1>
        <span className="text-gray-500">{user.name || user.email}</span>
      </header>

      <div className="max-w-7xl mx-auto p-6">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500 mb-1">Total Contacts</p>
            <p className="text-3xl font-bold text-gray-900">{stats.total}</p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500 mb-1">Leads</p>
            <p className="text-3xl font-bold text-yellow-600">{stats.leads}</p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500 mb-1">Customers</p>
            <p className="text-3xl font-bold text-green-600">{stats.customers}</p>
          </div>
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500 mb-1">Pipeline Value</p>
            <p className="text-3xl font-bold text-blue-600">${pipeline.totalValue.toLocaleString()}</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200 mb-5">
          {(['contacts', 'pipeline'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-blue-600'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {activeTab === 'contacts' && (
          <div className="bg-white rounded-xl shadow-sm">
            <div className="p-5 border-b border-gray-100 flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-900">Contacts</h2>
              <button
                onClick={() => setShowAddContact(true)}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
              >
                + Add Contact
              </button>
            </div>
            <div className="p-5">
              {/* Filters */}
              <div className="flex flex-wrap gap-3 mb-4">
                <input
                  type="text"
                  placeholder="Search contacts..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="flex-1 min-w-[200px] px-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm bg-white min-w-[150px]"
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
                  className="px-4 py-2 border border-gray-200 rounded-lg text-sm bg-white min-w-[150px]"
                >
                  <option value="">All Tags</option>
                  {tags.map(tag => (
                    <option key={tag.id} value={tag.id}>{tag.name}</option>
                  ))}
                </select>
              </div>

              {/* Contact List */}
              {filteredContacts.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <div className="text-4xl mb-4">👤</div>
                  <p>{contacts.length === 0 ? 'No contacts yet. Add your first contact!' : 'No contacts match your filters.'}</p>
                </div>
              ) : (
                <div>
                  {filteredContacts.map(contact => (
                    <div
                      key={contact.id}
                      onClick={() => setSelectedContact(contact)}
                      className="flex items-center gap-4 p-4 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 transition-colors"
                    >
                      <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center font-semibold text-gray-600">
                        {contact.firstName[0]}{contact.lastName[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-gray-900">{contact.firstName} {contact.lastName}</p>
                        <div className="flex gap-4 text-sm text-gray-500 mt-1">
                          {contact.email && <span>{contact.email}</span>}
                          {contact.company && <span>{contact.company.name}</span>}
                        </div>
                        {contact.tags && contact.tags.length > 0 && (
                          <div className="flex gap-1 mt-2">
                            {contact.tags.map(({ tag }) => (
                              <span
                                key={tag.id}
                                className="px-2 py-0.5 rounded-full text-xs font-medium"
                                style={{ backgroundColor: tag.color + '20', color: tag.color }}
                              >
                                {tag.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className={`px-3 py-1 rounded-full text-xs font-medium capitalize ${
                        contact.status === 'lead' ? 'bg-yellow-100 text-yellow-800' :
                        contact.status === 'prospect' ? 'bg-blue-100 text-blue-800' :
                        contact.status === 'customer' ? 'bg-green-100 text-green-800' :
                        'bg-red-100 text-red-800'
                      }`}>
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
          <div className="bg-white rounded-xl shadow-sm">
            <div className="p-5 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">Deal Pipeline</h2>
            </div>
            <div className="p-5">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                {pipeline.pipeline.map(stage => (
                  <div key={stage.stage} className="text-center p-4 bg-gray-50 rounded-lg">
                    <p className="text-xs uppercase text-gray-500 mb-2">{stage.stage}</p>
                    <p className="text-2xl font-bold text-gray-900">{stage.count}</p>
                    <p className="text-sm text-green-600">${stage.value.toLocaleString()}</p>
                  </div>
                ))}
              </div>
              <div className="mt-6 text-center">
                <p className="text-gray-500 mb-2">Total Won</p>
                <p className="text-4xl font-bold text-green-600">${pipeline.wonValue.toLocaleString()}</p>
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
      let companyId = formData.companyId || undefined
      if (showNewCompany && newCompanyName) {
        const company = await createCompany({ data: { name: newCompanyName, userId } })
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-lg font-semibold">Add Contact</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">First Name *</label>
                <input
                  type="text"
                  value={formData.firstName}
                  onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Last Name *</label>
                <input
                  type="text"
                  value={formData.lastName}
                  onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                  required
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Phone</label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Job Title</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Status</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="lead">Lead</option>
                  <option value="prospect">Prospect</option>
                  <option value="customer">Customer</option>
                  <option value="churned">Churned</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Company</label>
                {!showNewCompany ? (
                  <div className="flex gap-2">
                    <select
                      value={formData.companyId}
                      onChange={(e) => setFormData({ ...formData, companyId: e.target.value })}
                      className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">No Company</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setShowNewCompany(true)}
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50"
                    >
                      + New
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newCompanyName}
                      onChange={(e) => setNewCompanyName(e.target.value)}
                      placeholder="New company name"
                      className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      type="button"
                      onClick={() => { setShowNewCompany(false); setNewCompanyName('') }}
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Source</label>
                <select
                  value={formData.source}
                  onChange={(e) => setFormData({ ...formData, source: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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

            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Tags</label>
              <div className="flex flex-wrap gap-2 p-2 border border-gray-200 rounded-lg min-h-[44px]">
                {tags.filter(t => selectedTags.includes(t.id)).map(tag => (
                  <span
                    key={tag.id}
                    className="flex items-center gap-1 px-2 py-1 rounded-full text-xs"
                    style={{ backgroundColor: tag.color + '20', color: tag.color }}
                  >
                    {tag.name}
                    <button type="button" onClick={() => setSelectedTags(selectedTags.filter(id => id !== tag.id))}>×</button>
                  </span>
                ))}
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value && !selectedTags.includes(e.target.value)) {
                      setSelectedTags([...selectedTags, e.target.value])
                    }
                  }}
                  className="flex-1 min-w-[100px] text-sm border-none outline-none"
                >
                  <option value="">Add tag...</option>
                  {tags.filter(t => !selectedTags.includes(t.id)).map(tag => (
                    <option key={tag.id} value={tag.id}>{tag.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {error && <p className="text-red-600 text-sm">{error}</p>}
          </div>
          <div className="p-4 border-t border-gray-200 flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
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
  const [notes, setNotes] = useState<NoteType[]>([])
  const [newNote, setNewNote] = useState('')
  const [noteType, setNoteType] = useState('note')
  const [loading, setLoading] = useState(false)

  const loadNotes = async () => {
    try {
      const result = await getNotes({ data: { contactId: contact.id, userId } })
      setNotes(result)
    } catch (err) {
      console.error('Failed to load notes:', err)
    }
  }

  if (activeTab === 'activity' && notes.length === 0) {
    loadNotes()
  }

  const handleAddNote = async () => {
    if (!newNote.trim()) return

    setLoading(true)
    try {
      await createNote({ data: { content: newNote, type: noteType, contactId: contact.id, userId } })
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
      await updateContact({ data: { id: contact.id, userId, status: newStatus } })
      onUpdate()
    } catch (err) {
      console.error('Failed to update status:', err)
    }
  }

  const noteIcons: Record<string, string> = { note: '📝', call: '📞', email: '📧', meeting: '🤝' }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-200 flex justify-between items-center">
          <div>
            <h3 className="text-lg font-semibold">{contact.firstName} {contact.lastName}</h3>
            {contact.company && <p className="text-sm text-gray-500">{contact.company.name}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        <div className="flex gap-1 px-5 border-b border-gray-200">
          {(['details', 'activity'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-3 text-sm font-medium border-b-2 ${
                activeTab === tab ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)} {tab === 'activity' && `(${contact._count?.notes ?? 0})`}
            </button>
          ))}
        </div>

        <div className="p-5">
          {activeTab === 'details' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-gray-500">Email</label>
                  <p className={contact.email ? 'text-gray-900' : 'text-gray-400'}>{contact.email || 'Not provided'}</p>
                </div>
                <div>
                  <label className="text-sm text-gray-500">Phone</label>
                  <p className={contact.phone ? 'text-gray-900' : 'text-gray-400'}>{contact.phone || 'Not provided'}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-gray-500">Job Title</label>
                  <p className={contact.title ? 'text-gray-900' : 'text-gray-400'}>{contact.title || 'Not provided'}</p>
                </div>
                <div>
                  <label className="text-sm text-gray-500">Status</label>
                  <select
                    value={contact.status}
                    onChange={(e) => handleStatusChange(e.target.value)}
                    className="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
                  >
                    <option value="lead">Lead</option>
                    <option value="prospect">Prospect</option>
                    <option value="customer">Customer</option>
                    <option value="churned">Churned</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-sm text-gray-500">Tags</label>
                <div className="flex gap-2 mt-1">
                  {contact.tags && contact.tags.length > 0 ? (
                    contact.tags.map(({ tag }) => (
                      <span
                        key={tag.id}
                        className="px-2 py-1 rounded-full text-xs"
                        style={{ backgroundColor: tag.color + '20', color: tag.color }}
                      >
                        {tag.name}
                      </span>
                    ))
                  ) : (
                    <span className="text-gray-400">No tags</span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-gray-500">Source</label>
                  <p className={contact.source ? 'text-gray-900 capitalize' : 'text-gray-400'}>
                    {contact.source?.replace('_', ' ') || 'Unknown'}
                  </p>
                </div>
                <div>
                  <label className="text-sm text-gray-500">Created</label>
                  <p className="text-gray-500">{new Date(contact.createdAt).toLocaleDateString()}</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'activity' && (
            <div>
              {/* Add Note Form */}
              <div className="mb-5 p-4 bg-gray-50 rounded-lg">
                <div className="flex gap-2 mb-2">
                  {['note', 'call', 'email', 'meeting'].map(type => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setNoteType(type)}
                      className={`px-3 py-1 rounded text-sm ${
                        noteType === type ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200'
                      }`}
                    >
                      {noteIcons[type]} {type.charAt(0).toUpperCase() + type.slice(1)}
                    </button>
                  ))}
                </div>
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-y min-h-[80px]"
                />
                <button
                  onClick={handleAddNote}
                  disabled={loading || !newNote.trim()}
                  className="mt-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50"
                >
                  {loading ? 'Adding...' : 'Add Note'}
                </button>
              </div>

              {/* Activity List */}
              {notes.length === 0 ? (
                <p className="text-center text-gray-400 py-8">No activity yet. Add a note above!</p>
              ) : (
                <div className="space-y-3">
                  {notes.map(note => (
                    <div key={note.id} className="flex gap-3 py-3 border-b border-gray-100 last:border-0">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${
                        note.type === 'note' ? 'bg-indigo-100' :
                        note.type === 'call' ? 'bg-green-100' :
                        note.type === 'email' ? 'bg-yellow-100' : 'bg-pink-100'
                      }`}>
                        {noteIcons[note.type] || '📝'}
                      </div>
                      <div className="flex-1">
                        <p className="text-gray-800">{note.content}</p>
                        <p className="text-xs text-gray-400 mt-1">
                          {note.type.charAt(0).toUpperCase() + note.type.slice(1)} · {new Date(note.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-200 flex justify-between">
          <button onClick={handleDelete} className="px-4 py-2 bg-red-100 text-red-600 rounded-lg text-sm hover:bg-red-200">
            Delete Contact
          </button>
          <button onClick={onClose} className="px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
