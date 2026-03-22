// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Booking App
 */

import { useState, useEffect, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { api, configureApiClient } from './generated/api-client'
import {
  CalendarDays,
  Plus,
  Trash2,
  LogOut,
  Loader2,
  Clock,
  DollarSign,
  Check,
  X,
  Link,
  ArrowLeft,
  Briefcase,
  Copy,
  Mail,
  Phone,
  StickyNote,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

interface ServiceType {
  id: string
  name: string
  description: string | null
  duration: number
  price: number
  currency: string
  isActive: boolean
  color: string
}

interface BookingType {
  id: string
  status: string
  startTime: string
  endTime: string
  customerName: string
  customerEmail: string
  customerPhone: string | null
  notes: string | null
  confirmationCode: string
  service?: ServiceType
}

interface TimeSlotType {
  id: string
  dayOfWeek: number
  startTime: string
  endTime: string
  isActive: boolean
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function App() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/')

  useEffect(() => {
    const handleHash = () => setRoute(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  // Public booking page
  if (route.startsWith('/book/')) {
    const userId = route.replace('/book/', '')
    return <PublicBookingPage userId={userId} />
  }

  // Protected dashboard
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}

const Dashboard = observer(function Dashboard() {
  const { auth } = useStores()
  const [services, setServices] = useState<ServiceType[]>([])
  const [bookings, setBookings] = useState<BookingType[]>([])
  const [timeSlots, setTimeSlots] = useState<TimeSlotType[]>([])
  const [loading, setLoading] = useState(true)

  // Configure API client with user context
  useEffect(() => {
    if (auth.user) {
      configureApiClient({ userId: auth.user.id })
    }
  }, [auth.user?.id])

  const fetchData = useCallback(async () => {
    if (!auth.user) return
    try {
      const [svcRes, bookRes, slotRes] = await Promise.all([
        api.service.list(),
        api.booking.list({ params: { include: 'service' } }),
        api.timeSlot.list(),
      ])
      if (svcRes.ok) { setServices((svcRes.items || []) as any) }
      if (bookRes.ok) { setBookings((bookRes.items || []) as any) }
      if (slotRes.ok) { setTimeSlots((slotRes.items || []) as any) }
    } catch (err) {
      console.error('Failed to fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [auth.user])

  useEffect(() => { fetchData() }, [fetchData])

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    )
  }

  const shareLink = `${window.location.origin}/#/book/${auth.user?.id}`

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Sticky header */}
      <header className="sticky top-0 z-50 bg-background border-b px-6 py-3 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100">
            <CalendarDays className="h-5 w-5 text-violet-600" />
          </div>
          <h1 className="text-xl font-bold">Booking App</h1>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{auth.user?.name || auth.user?.email}</span>
          <Button variant="outline" size="sm" onClick={() => auth.signOut()}>
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Share link */}
        <Card className="bg-violet-50 border-violet-200">
          <CardContent className="flex items-center gap-3 py-0">
            <Link className="h-5 w-5 text-violet-600 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-violet-700 mb-1">Share your booking link</p>
              <code className="text-xs bg-white px-3 py-1.5 rounded border border-violet-200 block truncate font-mono">
                {shareLink}
              </code>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-violet-600 hover:text-violet-700 shrink-0"
              onClick={() => navigator.clipboard.writeText(shareLink)}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>

        {/* Tabs */}
        <Tabs defaultValue="bookings">
          <TabsList>
            <TabsTrigger value="bookings" className="gap-1.5">
              <CalendarDays className="h-4 w-4" />
              Bookings
            </TabsTrigger>
            <TabsTrigger value="services" className="gap-1.5">
              <Briefcase className="h-4 w-4" />
              Services
            </TabsTrigger>
            <TabsTrigger value="availability" className="gap-1.5">
              <Clock className="h-4 w-4" />
              Availability
            </TabsTrigger>
          </TabsList>

          <TabsContent value="bookings">
            <BookingsTab bookings={bookings} onUpdate={fetchData} />
          </TabsContent>
          <TabsContent value="services">
            <ServicesTab services={services} userId={auth.user!.id} onUpdate={fetchData} />
          </TabsContent>
          <TabsContent value="availability">
            <AvailabilityTab timeSlots={timeSlots} userId={auth.user!.id} onUpdate={fetchData} />
          </TabsContent>
        </Tabs>

        <footer className="text-center text-sm text-muted-foreground pt-4 pb-2">
          Built with @shogo-ai/sdk + Hono
        </footer>
      </div>
    </div>
  )
})

/* ─────────────────────── Bookings Tab ─────────────────────── */

function BookingsTab({ bookings, onUpdate }: { bookings: BookingType[]; onUpdate: () => void }) {
  const handleUpdateStatus = async (id: string, status: string) => {
    await api.booking.update(id, { status } as any)
    onUpdate()
  }

  const sortedBookings = [...bookings].sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Upcoming Bookings</h2>

      {sortedBookings.length === 0 ? (
        <Card className="py-12">
          <CardContent className="flex flex-col items-center justify-center text-center gap-3">
            <CalendarDays className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-muted-foreground">No bookings yet.</p>
          </CardContent>
        </Card>
      ) : (
        sortedBookings.map(booking => (
          <Card
            key={booking.id}
            className={`border-l-4 ${
              booking.status === 'CONFIRMED' ? 'border-l-green-500' :
              booking.status === 'PENDING' ? 'border-l-yellow-400' :
              booking.status === 'CANCELLED' ? 'border-l-red-400' : 'border-l-muted'
            }`}
          >
            <CardContent className="py-0">
              <div className="flex justify-between items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold truncate">{booking.customerName}</h3>
                    <Badge
                      variant="outline"
                      className={
                        booking.status === 'CONFIRMED' ? 'border-green-200 bg-green-50 text-green-700' :
                        booking.status === 'PENDING' ? 'border-yellow-200 bg-yellow-50 text-yellow-700' :
                        booking.status === 'CANCELLED' ? 'border-red-200 bg-red-50 text-red-600' :
                        ''
                      }
                    >
                      {booking.status}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Mail className="h-3.5 w-3.5" />
                    {booking.customerEmail}
                  </div>

                  <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                    <Clock className="h-3.5 w-3.5" />
                    {new Date(booking.startTime).toLocaleDateString()}{' '}
                    {new Date(booking.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} -{' '}
                    {new Date(booking.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>

                  {booking.service && (
                    <Badge
                      variant="outline"
                      className="mt-2"
                      style={{ backgroundColor: booking.service.color + '20', color: booking.service.color, borderColor: booking.service.color + '40' }}
                    >
                      {booking.service.name}
                    </Badge>
                  )}

                  {booking.notes && (
                    <div className="flex items-start gap-1 text-sm text-muted-foreground mt-2 italic">
                      <StickyNote className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      &ldquo;{booking.notes}&rdquo;
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground mt-2 font-mono">Code: {booking.confirmationCode}</p>
                </div>

                {booking.status === 'PENDING' && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      className="bg-green-600 hover:bg-green-700"
                      onClick={() => handleUpdateStatus(booking.id, 'CONFIRMED')}
                    >
                      <Check className="h-4 w-4" />
                      Confirm
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      onClick={() => handleUpdateStatus(booking.id, 'CANCELLED')}
                    >
                      <X className="h-4 w-4" />
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}

/* ─────────────────────── Services Tab ─────────────────────── */

function ServicesTab({ services, userId, onUpdate }: { services: ServiceType[]; userId: string; onUpdate: () => void }) {
  const [showAdd, setShowAdd] = useState(false)

  const handleAdd = async (data: Partial<ServiceType>) => {
    await api.service.create({ ...data, userId } as any)
    setShowAdd(false)
    onUpdate()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this service?')) return
    await api.service.delete(id)
    onUpdate()
  }

  const handleToggle = async (id: string, isActive: boolean) => {
    await api.service.update(id, { isActive: !isActive } as any)
    onUpdate()
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Services</h2>
        <Button className="bg-violet-600 hover:bg-violet-700" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4" />
          Add Service
        </Button>
      </div>

      {showAdd && <AddServiceForm onAdd={handleAdd} onCancel={() => setShowAdd(false)} />}

      {services.length === 0 ? (
        <Card className="py-12">
          <CardContent className="flex flex-col items-center justify-center text-center gap-3">
            <Briefcase className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-muted-foreground">No services yet. Add your first service!</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
          {services.map(service => (
            <Card
              key={service.id}
              className={`border-l-4 ${!service.isActive ? 'opacity-50' : ''}`}
              style={{ borderLeftColor: service.color }}
            >
              <CardHeader className="pb-0">
                <div className="flex justify-between items-start">
                  <CardTitle className="text-base">{service.name}</CardTitle>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-red-500"
                    onClick={() => handleDelete(service.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {service.description && (
                  <CardDescription>{service.description}</CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <div className="flex justify-between items-center text-sm">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    {service.duration} min
                  </span>
                  <span className="flex items-center gap-1 font-semibold" style={{ color: service.color }}>
                    <DollarSign className="h-3.5 w-3.5" />
                    {service.currency} {service.price}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full mt-3"
                  onClick={() => handleToggle(service.id, service.isActive)}
                >
                  {service.isActive ? 'Deactivate' : 'Activate'}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

/* ─────────────────────── Add Service Form ─────────────────────── */

function AddServiceForm({ onAdd, onCancel }: { onAdd: (data: Partial<ServiceType>) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [duration, setDuration] = useState('60')
  const [price, setPrice] = useState('0')
  const [color, setColor] = useState('#8B5CF6')

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Service</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="svc-name">Service name *</Label>
          <Input id="svc-name" placeholder="e.g. Consultation" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="svc-desc">Description</Label>
          <Input id="svc-desc" placeholder="Brief description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-2">
            <Label htmlFor="svc-dur">Duration (min)</Label>
            <Input id="svc-dur" type="number" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="svc-price">Price</Label>
            <Input id="svc-price" type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="svc-color">Color</Label>
            <Input id="svc-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 p-1 cursor-pointer" />
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <Button
            className="bg-violet-600 hover:bg-violet-700"
            onClick={() => name && onAdd({ name, description: description || null, duration: parseInt(duration), price: parseFloat(price), color })}
          >
            Add
          </Button>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  )
}

/* ─────────────────────── Availability Tab ─────────────────────── */

function AvailabilityTab({ timeSlots, userId, onUpdate }: { timeSlots: TimeSlotType[]; userId: string; onUpdate: () => void }) {
  const [showAdd, setShowAdd] = useState(false)

  const handleAdd = async (data: { dayOfWeek: number; startTime: string; endTime: string }) => {
    await api.timeSlot.create({ ...data, userId } as any)
    setShowAdd(false)
    onUpdate()
  }

  const handleDelete = async (id: string) => {
    await api.timeSlot.delete(id)
    onUpdate()
  }

  const slotsByDay = DAYS.map((day, i) => ({
    day,
    slots: timeSlots.filter(s => s.dayOfWeek === i).sort((a, b) => a.startTime.localeCompare(b.startTime))
  }))

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Availability</h2>
        <Button className="bg-violet-600 hover:bg-violet-700" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4" />
          Add Time Slot
        </Button>
      </div>

      {showAdd && <AddTimeSlotForm onAdd={handleAdd} onCancel={() => setShowAdd(false)} />}

      <Card>
        <CardContent>
          {slotsByDay.map(({ day, slots }) => (
            <div key={day} className="py-3 border-b last:border-0 flex items-center gap-4">
              <span className="w-24 font-medium text-sm">{day}</span>
              <div className="flex-1 flex flex-wrap gap-2">
                {slots.length === 0 ? (
                  <span className="text-muted-foreground text-sm">No availability</span>
                ) : (
                  slots.map(slot => (
                    <Badge
                      key={slot.id}
                      variant="outline"
                      className="border-green-200 bg-green-50 text-green-700 gap-1"
                    >
                      {slot.startTime} - {slot.endTime}
                      <button
                        onClick={() => handleDelete(slot.id)}
                        className="ml-1 text-green-400 hover:text-red-500 transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

/* ─────────────────────── Add Time Slot Form ─────────────────────── */

function AddTimeSlotForm({ onAdd, onCancel }: { onAdd: (data: { dayOfWeek: number; startTime: string; endTime: string }) => void; onCancel: () => void }) {
  const [dayOfWeek, setDayOfWeek] = useState('1')
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('17:00')

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Time Slot</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-2">
            <Label>Day</Label>
            <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS.map((d, i) => (
                  <SelectItem key={i} value={String(i)}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="slot-start">Start</Label>
            <Input id="slot-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="slot-end">End</Label>
            <Input id="slot-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            className="bg-violet-600 hover:bg-violet-700"
            onClick={() => onAdd({ dayOfWeek: parseInt(dayOfWeek), startTime, endTime })}
          >
            Add
          </Button>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  )
}

/* ─────────────────────── Public Booking Page ─────────────────────── */

function PublicBookingPage({ userId }: { userId: string }) {
  const [provider, setProvider] = useState<{ name: string; email: string } | null>(null)
  const [services, setServices] = useState<ServiceType[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedService, setSelectedService] = useState<ServiceType | null>(null)
  const [bookingSuccess, setBookingSuccess] = useState<{ code: string } | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const [userRes, svcRes] = await Promise.all([
          fetch(`/api/users/${userId}`),
          fetch(`/api/services?userId=${userId}&isActive=true`),
        ])
        if (userRes.ok) {
          const u = await userRes.json()
          setProvider({ name: u.name || u.email, email: u.email })
        } else {
          setError('Provider not found')
        }
        if (svcRes.ok) {
          const d = await svcRes.json()
          setServices(d.items || [])
        }
      } catch (err) {
        setError('Failed to load')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [userId])

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-gradient-to-br from-violet-500 to-purple-700">
        <Loader2 className="h-8 w-8 animate-spin text-white" />
        <p className="text-sm text-white/70">Loading...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-violet-500 to-purple-700">
        <Card className="w-full max-w-md text-center">
          <CardContent>
            <p className="text-destructive">{error}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (bookingSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-violet-500 to-purple-700">
        <Card className="w-full max-w-md text-center">
          <CardContent className="flex flex-col items-center gap-4 pt-2">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <Check className="h-8 w-8 text-green-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold mb-2">Booking Confirmed!</h1>
              <p className="text-muted-foreground mb-4">Your confirmation code:</p>
              <code className="text-xl font-mono bg-muted px-4 py-2 rounded-lg">{bookingSuccess.code}</code>
            </div>
            <p className="text-sm text-muted-foreground">You&apos;ll receive a confirmation email shortly.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-4 bg-gradient-to-br from-violet-500 to-purple-700">
      <div className="max-w-2xl mx-auto space-y-4">
        {/* Provider header */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-100">
                <CalendarDays className="h-6 w-6 text-violet-600" />
              </div>
              <div>
                <CardTitle className="text-xl">Book with {provider?.name}</CardTitle>
                <CardDescription>Select a service to book an appointment.</CardDescription>
              </div>
            </div>
          </CardHeader>
        </Card>

        {selectedService ? (
          <BookingForm
            service={selectedService}
            userId={userId}
            onBack={() => setSelectedService(null)}
            onSuccess={(code) => setBookingSuccess({ code })}
          />
        ) : (
          <div className="space-y-3">
            {services.length === 0 ? (
              <Card className="py-12">
                <CardContent className="flex flex-col items-center justify-center text-center gap-3">
                  <Briefcase className="h-10 w-10 text-muted-foreground/40" />
                  <p className="text-muted-foreground">No services available.</p>
                </CardContent>
              </Card>
            ) : (
              services.map(svc => (
                <Card
                  key={svc.id}
                  className="border-l-4 cursor-pointer hover:shadow-md transition-shadow"
                  style={{ borderLeftColor: svc.color }}
                  onClick={() => setSelectedService(svc)}
                >
                  <CardContent className="py-0">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="font-semibold">{svc.name}</h3>
                        {svc.description && <p className="text-sm text-muted-foreground mt-1">{svc.description}</p>}
                        <div className="flex items-center gap-1 text-sm text-muted-foreground mt-2">
                          <Clock className="h-3.5 w-3.5" />
                          {svc.duration} min
                        </div>
                      </div>
                      <span className="font-semibold flex items-center gap-1" style={{ color: svc.color }}>
                        <DollarSign className="h-4 w-4" />
                        {svc.currency} {svc.price}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* ─────────────────────── Booking Form ─────────────────────── */

function BookingForm({ service, userId, onBack, onSuccess }: { service: ServiceType; userId: string; onBack: () => void; onSuccess: (code: string) => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !email || !date || !time) return

    setLoading(true)
    setError('')

    const startTime = new Date(`${date}T${time}`)
    const endTime = new Date(startTime.getTime() + service.duration * 60000)

    try {
      const res = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          serviceId: service.id,
          customerName: name,
          customerEmail: email,
          customerPhone: phone || null,
          notes: notes || null,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
        }),
      })
      const data = await res.json()
      if (res.ok) {
        onSuccess(data.confirmationCode)
      } else {
        setError(data.error || 'Failed to book')
      }
    } catch (err) {
      setError('Failed to book')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <Button
          variant="ghost"
          size="sm"
          className="w-fit -ml-2 text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to services
        </Button>
        <CardTitle>{service.name}</CardTitle>
        <CardDescription className="flex items-center gap-3">
          <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {service.duration} min</span>
          <span className="flex items-center gap-1" style={{ color: service.color }}><DollarSign className="h-3.5 w-3.5" /> {service.currency} {service.price}</span>
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="book-name">Your name *</Label>
            <Input id="book-name" placeholder="John Doe" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>

          <div className="space-y-2">
            <Label htmlFor="book-email">Email address *</Label>
            <Input id="book-email" type="email" placeholder="john@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>

          <div className="space-y-2">
            <Label htmlFor="book-phone">Phone (optional)</Label>
            <Input id="book-phone" type="tel" placeholder="+1 (555) 000-0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="book-date">Date *</Label>
              <Input id="book-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required min={new Date().toISOString().split('T')[0]} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="book-time">Time *</Label>
              <Input id="book-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="book-notes">Notes (optional)</Label>
            <textarea
              id="book-notes"
              placeholder="Any additional information..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-violet-600 hover:bg-violet-700"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Booking...
              </>
            ) : (
              'Confirm Booking'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
