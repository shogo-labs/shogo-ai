/**
 * CRM App
 * 
 * Contact management with companies, deals, and notes.
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { api, configureApiClient } from './generated/api-client'
import {
  Users,
  TrendingUp,
  UserCheck,
  DollarSign,
  Plus,
  Trash2,
  Search,
  LogOut,
  Loader2,
  UserPlus,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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

function getStatusBadge(status: string) {
  switch (status) {
    case 'lead':
      return <Badge variant="outline" className="border-yellow-300 bg-yellow-50 text-yellow-700">Lead</Badge>
    case 'prospect':
      return <Badge className="bg-blue-100 text-blue-700 border-blue-200">Prospect</Badge>
    case 'customer':
      return <Badge className="bg-green-100 text-green-700 border-green-200">Customer</Badge>
    case 'churned':
      return <Badge variant="destructive">Churned</Badge>
    default:
      return <Badge variant="secondary">{status}</Badge>
  }
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

  // Configure API client with user context
  useEffect(() => {
    if (auth.user) {
      configureApiClient({ userId: auth.user.id })
    }
  }, [auth.user?.id])

  const fetchData = useCallback(async () => {
    if (!auth.user) return

    try {
      // Use API client for standard CRUD, raw fetch only for custom endpoints
      const [contactsRes, companiesRes, statsRes, pipelineRes] = await Promise.all([
        api.contact.list({ params: { include: 'company' } }),
        api.company.list(),
        fetch(`/api/contacts/stats?userId=${auth.user.id}`),
        fetch(`/api/deals/pipeline?userId=${auth.user.id}`),
      ])

      if (contactsRes.ok) {
        setContacts((contactsRes.items || []) as any)
      }
      if (companiesRes.ok) {
        setCompanies((companiesRes.items || []) as any)
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
    await api.contact.delete(id)
    fetchData()
  }

  const handleUpdateStatus = async (id: string, status: string) => {
    await api.contact.update(id, { status } as any)
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
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50/50">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-sm border-b">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Users className="h-4 w-4" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">CRM</h1>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{auth.user?.name || auth.user?.email}</span>
            <Button variant="outline" size="sm" onClick={() => auth.signOut()}>
              <LogOut className="h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-0">
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50">
                    <Users className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Contacts</p>
                    <p className="text-2xl font-bold">{stats.total}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-0">
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-yellow-50">
                    <TrendingUp className="h-5 w-5 text-yellow-600" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Leads</p>
                    <p className="text-2xl font-bold">{stats.leads}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-0">
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-green-50">
                    <UserCheck className="h-5 w-5 text-green-600" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Customers</p>
                    <p className="text-2xl font-bold">{stats.customers}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-0">
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-50">
                    <DollarSign className="h-5 w-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Pipeline Value</p>
                    <p className="text-2xl font-bold">${(pipeline?.totalValue || 0).toLocaleString()}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Pipeline */}
        {pipeline && pipeline.pipeline.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Deal Pipeline</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 overflow-x-auto">
                {pipeline.pipeline.map(({ stage, count, value }) => (
                  <div key={stage} className="flex-1 min-w-[120px] p-3 bg-muted rounded-lg text-center">
                    <p className="text-xs text-muted-foreground capitalize">{stage}</p>
                    <p className="text-lg font-bold">{count}</p>
                    <p className="text-xs text-muted-foreground">${value.toLocaleString()}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Contacts */}
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <div>
                <CardTitle>Contacts</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">{filteredContacts.length} contact{filteredContacts.length !== 1 ? 's' : ''}</p>
              </div>
              <Button onClick={() => setShowAddContact(!showAddContact)}>
                {showAddContact ? (
                  'Cancel'
                ) : (
                  <>
                    <Plus className="h-4 w-4" />
                    Add Contact
                  </>
                )}
              </Button>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {/* Filters */}
            <div className="flex gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search contacts..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="lead">Lead</SelectItem>
                  <SelectItem value="prospect">Prospect</SelectItem>
                  <SelectItem value="customer">Customer</SelectItem>
                  <SelectItem value="churned">Churned</SelectItem>
                </SelectContent>
              </Select>
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
              <p className="text-center text-muted-foreground py-8">No contacts found</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[80px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredContacts.map((contact) => (
                    <TableRow key={contact.id}>
                      <TableCell>
                        <div className="font-medium">{contact.firstName} {contact.lastName}</div>
                        {contact.title && <div className="text-xs text-muted-foreground">{contact.title}</div>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{contact.email || '-'}</TableCell>
                      <TableCell className="text-muted-foreground">{contact.company?.name || '-'}</TableCell>
                      <TableCell>
                        <Select
                          value={contact.status}
                          onValueChange={(value) => handleUpdateStatus(contact.id, value)}
                        >
                          <SelectTrigger className="h-7 w-auto border-none shadow-none px-0 gap-1 focus:ring-0">
                            <SelectValue>
                              {getStatusBadge(contact.status)}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="lead">Lead</SelectItem>
                            <SelectItem value="prospect">Prospect</SelectItem>
                            <SelectItem value="customer">Customer</SelectItem>
                            <SelectItem value="churned">Churned</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleDeleteContact(contact.id)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <footer className="text-center text-sm text-muted-foreground pb-4">
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
      const result = await api.contact.create({
        firstName,
        lastName,
        email: email || null,
        phone: phone || null,
        title: title || null,
        status,
        companyId: companyId || null,
        userId,
      } as any)

      if (!result.ok) {
        throw new Error(result.error?.message || 'Failed to create contact')
      }

      onAdd()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create contact')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="bg-muted/50">
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="firstName">First name *</Label>
              <Input
                id="firstName"
                type="text"
                placeholder="First name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">Last name *</Label>
              <Input
                id="lastName"
                type="text"
                placeholder="Last name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="contactEmail">Email</Label>
              <Input
                id="contactEmail"
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contactPhone">Phone</Label>
              <Input
                id="contactPhone"
                type="tel"
                placeholder="Phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="contactTitle">Job title</Label>
              <Input
                id="contactTitle"
                type="text"
                placeholder="Job title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lead">Lead</SelectItem>
                  <SelectItem value="prospect">Prospect</SelectItem>
                  <SelectItem value="customer">Customer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Company (optional)</Label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select company" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No company</SelectItem>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Adding...
              </>
            ) : (
              <>
                <UserPlus className="h-4 w-4" />
                Add Contact
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
