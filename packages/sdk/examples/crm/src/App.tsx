/**
 * CRM App
 * 
 * Contact management with companies, deals, and notes.
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'

// Types
interface ContactType {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  title: string | null
  status: string
  source: string | null
  companyId: string | null
  userId: string
  company?: CompanyType
  tags?: { tag: TagType }[]
}

interface CompanyType {
  id: string
  name: string
  website: string | null
  industry: string | null
  size: string | null
}

interface TagType {
  id: string
  name: string
  color: string
}

interface StatsType {
  total: number
  leads: number
  prospects: number
  customers: number
  churned: number
}

interface PipelineType {
  pipeline: { stage: string; count: number; value: number }[]
  totalValue: number
  wonValue: number
}

export default function App() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}

const Dashboard = observer(function Dashboard() {
  const { auth } = useStores()
  const [contacts, setContacts] = useState<ContactType[]>([])
  const [companies, setCompanies] = useState<CompanyType[]>([])
  const [stats, setStats] = useState<StatsType | null>(null)
  const [pipeline, setPipeline] = useState<PipelineType | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAddContact, setShowAddContact] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')

  const fetchData = useCallback(async () => {
    if (!auth.user) return

    try {
      const [contactsRes, companiesRes, statsRes, pipelineRes] = await Promise.all([
        fetch(`/api/contacts?userId=${auth.user.id}&include=company`),
        fetch(`/api/companies?userId=${auth.user.id}`),
        fetch(`/api/contacts/stats?userId=${auth.user.id}`),
        fetch(`/api/deals/pipeline?userId=${auth.user.id}`),
      ])

      if (contactsRes.ok) {
        const data = await contactsRes.json()
        setContacts(data.items || [])
      }
      if (companiesRes.ok) {
        const data = await companiesRes.json()
        setCompanies(data.items || [])
      }
      if (statsRes.ok) {
        setStats(await statsRes.json())
      }
      if (pipelineRes.ok) {
        setPipeline(await pipelineRes.json())
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

  const handleDeleteContact = async (id: string) => {
    if (!confirm('Delete this contact?')) return
    await fetch(`/api/contacts/${id}`, { method: 'DELETE' })
    fetchData()
  }

  const handleUpdateStatus = async (id: string, status: string) => {
    await fetch(`/api/contacts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    fetchData()
  }

  const filteredContacts = contacts.filter(contact => {
    if (statusFilter && contact.status !== statusFilter) return false
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">CRM</h1>
        <div className="flex items-center gap-4">
          <span className="text-gray-500">{auth.user?.name || auth.user?.email}</span>
          <button
            onClick={() => auth.signOut()}
            className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            Sign Out
          </button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-6">
        {/* Stats */}
        {stats && (
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
              <p className="text-3xl font-bold text-blue-600">${(pipeline?.totalValue || 0).toLocaleString()}</p>
            </div>
          </div>
        )}

        {/* Pipeline */}
        {pipeline && pipeline.pipeline.length > 0 && (
          <div className="bg-white rounded-xl p-5 shadow-sm mb-6">
            <h3 className="font-semibold text-gray-900 mb-4">Deal Pipeline</h3>
            <div className="flex gap-2 overflow-x-auto">
              {pipeline.pipeline.map(({ stage, count, value }) => (
                <div key={stage} className="flex-1 min-w-[120px] p-3 bg-gray-50 rounded-lg text-center">
                  <p className="text-xs text-gray-500 capitalize">{stage}</p>
                  <p className="text-lg font-bold">{count}</p>
                  <p className="text-xs text-gray-400">${value.toLocaleString()}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Contacts */}
        <div className="bg-white rounded-xl p-5 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-gray-900">Contacts</h3>
            <button
              onClick={() => setShowAddContact(!showAddContact)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              {showAddContact ? 'Cancel' : '+ Add Contact'}
            </button>
          </div>

          {/* Filters */}
          <div className="flex gap-4 mb-4">
            <input
              type="text"
              placeholder="Search contacts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-4 py-2 border border-gray-200 rounded-lg text-sm bg-white"
            >
              <option value="">All Status</option>
              <option value="lead">Lead</option>
              <option value="prospect">Prospect</option>
              <option value="customer">Customer</option>
              <option value="churned">Churned</option>
            </select>
          </div>

          {showAddContact && (
            <AddContactForm
              userId={auth.user!.id}
              companies={companies}
              onAdd={() => {
                setShowAddContact(false)
                fetchData()
              }}
            />
          )}

          {/* Contact List */}
          {filteredContacts.length === 0 ? (
            <p className="text-center text-gray-400 py-8">No contacts found</p>
          ) : (
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr className="text-sm text-gray-500 border-b border-gray-100">
                    <th className="font-medium">Name</th>
                    <th className="font-medium">Email</th>
                    <th className="font-medium">Company</th>
                    <th className="font-medium">Status</th>
                    <th className="font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredContacts.map((contact) => (
                    <tr key={contact.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td>
                        <div className="font-medium text-gray-900">{contact.firstName} {contact.lastName}</div>
                        {contact.title && <div className="text-xs text-gray-400">{contact.title}</div>}
                      </td>
                      <td className="text-gray-600">{contact.email || '-'}</td>
                      <td className="text-gray-600">{contact.company?.name || '-'}</td>
                      <td>
                        <select
                          value={contact.status}
                          onChange={(e) => handleUpdateStatus(contact.id, e.target.value)}
                          className={`px-2 py-1 rounded text-xs font-medium border-0 ${
                            contact.status === 'lead' ? 'bg-yellow-100 text-yellow-700' :
                            contact.status === 'prospect' ? 'bg-blue-100 text-blue-700' :
                            contact.status === 'customer' ? 'bg-green-100 text-green-700' :
                            'bg-red-100 text-red-700'
                          }`}
                        >
                          <option value="lead">Lead</option>
                          <option value="prospect">Prospect</option>
                          <option value="customer">Customer</option>
                          <option value="churned">Churned</option>
                        </select>
                      </td>
                      <td>
                        <button
                          onClick={() => handleDeleteContact(contact.id)}
                          className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <footer className="text-center text-gray-400 text-sm mt-8">
          <p>Built with @shogo-ai/sdk + Hono</p>
        </footer>
      </div>
    </div>
  )
})

function AddContactForm({
  userId,
  companies,
  onAdd,
}: {
  userId: string
  companies: CompanyType[]
  onAdd: () => void
}) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState('lead')
  const [companyId, setCompanyId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!firstName || !lastName) return

    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName,
          lastName,
          email: email || null,
          phone: phone || null,
          title: title || null,
          status,
          companyId: companyId || null,
          userId,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error?.message || 'Failed to create contact')
      }

      onAdd()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create contact')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-gray-50 rounded-lg p-4 mb-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <input
          type="text"
          placeholder="First name *"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          required
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm"
        />
        <input
          type="text"
          placeholder="Last name *"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          required
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm"
        />
        <input
          type="tel"
          placeholder="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <input
          type="text"
          placeholder="Job title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm bg-white"
        >
          <option value="lead">Lead</option>
          <option value="prospect">Prospect</option>
          <option value="customer">Customer</option>
        </select>
      </div>
      <select
        value={companyId}
        onChange={(e) => setCompanyId(e.target.value)}
        className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm bg-white"
      >
        <option value="">Select company (optional)</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? 'Adding...' : 'Add Contact'}
      </button>
    </form>
  )
}
