// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
  FlatList,
  useWindowDimensions,
} from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  AlertCircle,
  Check,
  Search,
  Bot,
  ChevronRight,
  ChevronDown,
  Eye,
  EyeOff,
  Save,
  Send,
  Info,
  Plus,
  X,
} from 'lucide-react-native'
import { useDomainHttp } from '../../../../../contexts/domain'
import { cn } from '@shogo/shared-ui/primitives'
import { KNOWN_INTEGRATIONS, MARKETPLACE_CATEGORIES } from '@shogo/shared-app'
import {
  AgentTile,
  type AgentTileListing,
  CreatorChip,
  PriceTag,
  PricingCards,
  StarRating,
  installCtaLabel,
  getAccentColor,
  getInitial,
} from '../../../../../components/marketplace'

const PRICING_MODELS = [
  { value: 'free', label: 'Free', description: 'Anyone can install at no cost' },
  {
    value: 'one_time',
    label: 'One-time purchase',
    description: 'Single payment for lifetime access',
  },
  {
    value: 'subscription',
    label: 'Subscription',
    description: 'Recurring monthly or annual charge',
  },
] as const

const INSTALL_MODELS = [
  {
    value: 'fork',
    label: 'Fork (independent copy)',
    description: 'Buyers get a standalone copy they can modify freely',
  },
  {
    value: 'linked',
    label: 'Linked (receives updates)',
    description: 'Buyers stay linked and receive your future updates',
  },
] as const

interface ListingForm {
  title: string
  shortDescription: string
  longDescription: string
  category: string
  tags: string
  pricingModel: 'free' | 'one_time' | 'subscription'
  priceInCents: string
  monthlyPriceInCents: string
  annualPriceInCents: string
  installModel: 'fork' | 'linked'
}

interface ListingData {
  id: string
  title: string
  shortDescription: string
  longDescription: string
  category: string
  tags: string[]
  pricingModel: 'free' | 'one_time' | 'subscription'
  priceInCents: number
  monthlyPriceInCents: number
  annualPriceInCents: number
  installModel: 'fork' | 'linked'
  status: string
  projectId: string
}

interface ProjectItem {
  id: string
  name: string
  description?: string | null
}

const INITIAL_FORM: ListingForm = {
  title: '',
  shortDescription: '',
  longDescription: '',
  category: 'personal',
  tags: '',
  pricingModel: 'free',
  priceInCents: '',
  monthlyPriceInCents: '',
  annualPriceInCents: '',
  installModel: 'fork',
}

function centsToDisplay(cents: number): string {
  return cents > 0 ? (cents / 100).toFixed(2) : ''
}

function displayToCents(display: string): number {
  const n = parseFloat(display)
  return isNaN(n) ? 0 : Math.round(n * 100)
}

type SectionKey = 'basics' | 'pricing' | 'install' | 'tags' | 'publish'

const KNOWN_INTEGRATION_KEYS = Object.keys(KNOWN_INTEGRATIONS).sort()

export default observer(function EditListingScreen() {
  const router = useRouter()
  const { id, projectId: initialProjectId } = useLocalSearchParams<{
    id: string
    projectId?: string
  }>()
  const http = useDomainHttp()
  const { width } = useWindowDimensions()
  const isWide = width >= 1024

  const isNew = id === 'new'

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialProjectId ?? null,
  )
  const [showProjectPicker, setShowProjectPicker] = useState(
    isNew && !initialProjectId,
  )

  const [form, setForm] = useState<ListingForm>(INITIAL_FORM)
  const [existingStatus, setExistingStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [unlisting, setUnlisting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectSearch, setProjectSearch] = useState('')

  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    basics: true,
    pricing: true,
    install: false,
    tags: false,
    publish: false,
  })
  const [previewVisible, setPreviewVisible] = useState(true)
  const [tagSuggestionFocus, setTagSuggestionFocus] = useState(false)

  // ── Loading ──────────────────────────────────────────────────────
  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    try {
      const res = await http.get<{ items: ProjectItem[] }>('/api/projects')
      const raw = res.data
      const items = Array.isArray(raw) ? raw : (raw as any)?.items ?? []
      setProjects(items)
    } catch (err) {
      console.error('[ListingEditor] Failed to load projects:', err)
      setProjects([])
    } finally {
      setProjectsLoading(false)
    }
  }, [http])

  useEffect(() => {
    if (showProjectPicker) loadProjects()
  }, [showProjectPicker, loadProjects])

  const filteredProjects = useMemo(() => {
    let list = projects
    if (projectSearch.trim()) {
      const q = projectSearch.toLowerCase()
      list = list.filter(
        (p) =>
          p.name?.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q),
      )
    }
    return list
  }, [projects, projectSearch])

  const loadListing = useCallback(async () => {
    if (isNew) return
    setLoading(true)
    try {
      const res = await http.get<{ listings: ListingData[] }>(
        '/api/marketplace/creator/listings',
      )
      const items = res.data?.listings ?? res.data
      const list = Array.isArray(items) ? items : []
      const listing = list.find((l) => l.id === id)
      if (!listing) {
        setError('Listing not found')
        return
      }
      setExistingStatus(listing.status)
      setSelectedProjectId(listing.projectId)
      setForm({
        title: listing.title,
        shortDescription: listing.shortDescription || '',
        longDescription: listing.longDescription || '',
        category: listing.category || 'personal',
        tags: (listing.tags || []).join(', '),
        pricingModel: listing.pricingModel || 'free',
        priceInCents: centsToDisplay(listing.priceInCents),
        monthlyPriceInCents: centsToDisplay(listing.monthlyPriceInCents),
        annualPriceInCents: centsToDisplay(listing.annualPriceInCents),
        installModel: listing.installModel || 'fork',
      })
    } catch {
      setError('Failed to load listing')
    } finally {
      setLoading(false)
    }
  }, [http, id, isNew])

  useEffect(() => {
    loadListing()
  }, [loadListing])

  // ── Form helpers ─────────────────────────────────────────────────
  const updateField = useCallback((field: keyof ListingForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
    setError(null)
    setSuccess(null)
  }, [])

  const fieldErrors = useMemo(() => {
    const errors: Partial<Record<keyof ListingForm | 'project', string>> = {}
    if (form.title.trim().length === 0) errors.title = 'Required'
    else if (form.title.trim().length > 60) errors.title = 'Keep under 60 characters'
    if (form.shortDescription.trim().length === 0) errors.shortDescription = 'Required'
    else if (form.shortDescription.length > 160) errors.shortDescription = 'Keep under 160 characters'
    if (form.pricingModel === 'one_time' && !form.priceInCents.trim()) {
      errors.priceInCents = 'Set a one-time price'
    }
    if (
      form.pricingModel === 'subscription' &&
      !form.monthlyPriceInCents.trim() &&
      !form.annualPriceInCents.trim()
    ) {
      errors.monthlyPriceInCents = 'Set monthly or annual price'
    }
    if (isNew && !selectedProjectId) errors.project = 'Pick an agent to publish'
    return errors
  }, [form, isNew, selectedProjectId])

  const sectionDone: Record<SectionKey, boolean> = useMemo(
    () => ({
      basics:
        !!form.title.trim() &&
        !!form.shortDescription.trim() &&
        !fieldErrors.title &&
        !fieldErrors.shortDescription,
      pricing:
        !fieldErrors.priceInCents && !fieldErrors.monthlyPriceInCents,
      install: !!form.installModel,
      tags: form.tags.trim().length > 0,
      publish: !!form.title.trim() && !!form.shortDescription.trim(),
    }),
    [form, fieldErrors],
  )

  const buildPayload = useCallback(() => {
    return {
      title: form.title.trim(),
      shortDescription: form.shortDescription.trim(),
      longDescription: form.longDescription.trim(),
      category: form.category,
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      pricingModel: form.pricingModel,
      priceInCents:
        form.pricingModel === 'one_time' ? displayToCents(form.priceInCents) : 0,
      monthlyPriceInCents:
        form.pricingModel === 'subscription'
          ? displayToCents(form.monthlyPriceInCents)
          : 0,
      annualPriceInCents:
        form.pricingModel === 'subscription'
          ? displayToCents(form.annualPriceInCents)
          : 0,
      installModel: form.installModel,
      ...(isNew && selectedProjectId ? { projectId: selectedProjectId } : {}),
    }
  }, [form, isNew, selectedProjectId])

  const validate = useCallback((): string | null => {
    const first = Object.values(fieldErrors)[0]
    return first ?? null
  }, [fieldErrors])

  const handleSave = useCallback(async () => {
    const err = validate()
    if (err) {
      setError(err)
      return
    }
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const payload = buildPayload()
      if (isNew) {
        const res = await http.post<{ listing: ListingData }>(
          '/api/marketplace/creator/listings',
          payload,
        )
        const created = res.data?.listing ?? res.data
        setSuccess('Listing created!')
        router.replace({
          pathname: '/(app)/marketplace/creator/listing/[id]',
          params: { id: (created as any).id },
        })
      } else {
        await http.patch(`/api/marketplace/creator/listings/${id}`, payload)
        setSuccess('Changes saved!')
      }
    } catch {
      setError('Failed to save listing')
    } finally {
      setSaving(false)
    }
  }, [validate, buildPayload, isNew, http, id, router])

  const handlePublish = useCallback(async () => {
    if (isNew || existingStatus !== 'draft') return
    const err = validate()
    if (err) {
      setError(err)
      return
    }
    setPublishing(true)
    setError(null)
    try {
      await http.post(`/api/marketplace/creator/listings/${id}/publish`, {})
      setExistingStatus('published')
      setSuccess('Listing published! It is now visible on the marketplace.')
    } catch {
      setError('Failed to publish listing')
    } finally {
      setPublishing(false)
    }
  }, [isNew, existingStatus, http, id, validate])

  const handleUnlist = useCallback(async () => {
    if (isNew || existingStatus !== 'published') return
    setUnlisting(true)
    setError(null)
    try {
      await http.post(`/api/marketplace/creator/listings/${id}/unpublish`, {})
      setExistingStatus('archived')
      setSuccess('Listing unlisted. It is no longer visible on the marketplace.')
    } catch {
      setError('Failed to unlist listing')
    } finally {
      setUnlisting(false)
    }
  }, [isNew, existingStatus, http, id])

  // ── Tag chip operations ──────────────────────────────────────────
  const tagsArray = useMemo(
    () =>
      form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    [form.tags],
  )
  const tagSuggestions = useMemo(() => {
    const present = new Set(tagsArray.map((t) => t.toLowerCase()))
    return KNOWN_INTEGRATION_KEYS.filter((k) => !present.has(k)).slice(0, 12)
  }, [tagsArray])

  const addTag = (tag: string) => {
    if (tagsArray.map((t) => t.toLowerCase()).includes(tag.toLowerCase())) return
    const next = [...tagsArray, tag].join(', ')
    updateField('tags', next)
  }
  const removeTag = (tag: string) => {
    const next = tagsArray.filter((t) => t.toLowerCase() !== tag.toLowerCase()).join(', ')
    updateField('tags', next)
  }

  // ── Live preview tile ────────────────────────────────────────────
  const previewListing: AgentTileListing = useMemo(
    () => ({
      slug: 'preview',
      title: form.title || 'Untitled agent',
      shortDescription:
        form.shortDescription || 'Add a short description to see it here.',
      iconUrl: null,
      previewUrl: null,
      pricingModel: form.pricingModel,
      priceInCents: displayToCents(form.priceInCents) || null,
      monthlyPriceInCents: displayToCents(form.monthlyPriceInCents) || null,
      installCount: 0,
      averageRating: 0,
      reviewCount: 0,
      featured: false,
      creator: {
        id: 'preview-creator',
        displayName: 'You',
        creatorTier: 'newcomer',
      },
    }),
    [form],
  )
  const previewAccent = getAccentColor(form.title || 'preview')
  const previewInitial = getInitial(form.title || 'A')

  // ── Project picker ───────────────────────────────────────────────
  if (showProjectPicker) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-row items-center gap-3 px-5 pt-3 pb-2">
          <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
            <ArrowLeft size={20} color="#71717a" />
          </Pressable>
          <Text className="text-base font-semibold text-foreground flex-1">
            Select an agent
          </Text>
        </View>
        <Text className="px-5 text-sm text-muted-foreground mb-3">
          Choose which agent project you want to publish on the marketplace.
        </Text>
        <View className="px-5 pb-3">
          <View className="flex-row items-center bg-card border border-input rounded-xl px-3 h-11">
            <Search size={16} color="#71717a" />
            <TextInput
              className="flex-1 ml-2 text-sm text-foreground web:outline-none"
              placeholder="Search your agents…"
              placeholderTextColor="#71717a"
              value={projectSearch}
              onChangeText={setProjectSearch}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>
        {projectsLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" />
          </View>
        ) : filteredProjects.length === 0 ? (
          <View className="flex-1 items-center justify-center px-6">
            <Bot size={40} color="#a1a1aa" />
            <Text className="text-foreground font-medium mt-3 mb-1">
              {projectSearch ? 'No matching agents' : 'No agents found'}
            </Text>
            <Text className="text-muted-foreground text-sm text-center">
              {projectSearch
                ? `No agents match "${projectSearch}"`
                : 'Create an agent first before publishing to the marketplace.'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={filteredProjects}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
            ItemSeparatorComponent={() => <View className="h-2" />}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  setSelectedProjectId(item.id)
                  setShowProjectPicker(false)
                  if (!form.title.trim()) {
                    setForm((prev) => ({
                      ...prev,
                      title: item.name || '',
                      shortDescription: item.description || '',
                    }))
                  }
                }}
                className="p-4 rounded-2xl border border-border bg-card active:bg-muted flex-row items-center gap-3"
              >
                <View className="w-10 h-10 rounded-xl bg-primary/10 items-center justify-center">
                  <Bot size={18} color="#e27927" />
                </View>
                <View className="flex-1">
                  <Text
                    className="text-sm font-semibold text-foreground"
                    numberOfLines={1}
                  >
                    {item.name || 'Untitled agent'}
                  </Text>
                  {item.description ? (
                    <Text
                      className="text-xs text-muted-foreground mt-0.5"
                      numberOfLines={2}
                    >
                      {item.description}
                    </Text>
                  ) : null}
                </View>
                <ChevronRight size={16} color="#71717a" />
              </Pressable>
            )}
          />
        )}
      </View>
    )
  }

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId)

  // ── Section toggles ──────────────────────────────────────────────
  const toggleSection = (k: SectionKey) =>
    setOpenSections((prev) => ({ ...prev, [k]: !prev[k] }))

  // ── Form column ──────────────────────────────────────────────────
  const formColumn = (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* Feedback */}
      {error && (
        <View className="flex-row items-center gap-2 mb-4 px-4 py-3 rounded-xl bg-destructive/10">
          <AlertCircle size={16} color="#dc2626" />
          <Text className="text-sm text-destructive flex-1">{error}</Text>
        </View>
      )}
      {success && (
        <View className="flex-row items-center gap-2 mb-4 px-4 py-3 rounded-xl bg-emerald-500/10">
          <Check size={16} color="#16a34a" />
          <Text className="text-sm text-emerald-700 dark:text-emerald-400 flex-1">
            {success}
          </Text>
        </View>
      )}

      {/* Project pick (new only) */}
      {isNew && selectedProjectId && (
        <Pressable
          onPress={() => setShowProjectPicker(true)}
          className="flex-row items-center gap-3 p-3 rounded-2xl border border-primary/30 bg-primary/5 mb-4"
        >
          <View className="w-9 h-9 rounded-xl bg-primary/15 items-center justify-center">
            <Bot size={16} color="#e27927" />
          </View>
          <View className="flex-1 min-w-0">
            <Text className="text-[10px] font-semibold uppercase text-primary mb-0.5">
              Agent
            </Text>
            <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
              {selectedProject?.name || selectedProjectId}
            </Text>
          </View>
          <Text className="text-xs text-primary font-medium">Change</Text>
        </Pressable>
      )}

      {/* Basics */}
      <Section
        title="Basics"
        subtitle="Title, descriptions, and category"
        done={sectionDone.basics}
        open={openSections.basics}
        onToggle={() => toggleSection('basics')}
      >
        <FormField label="Title" error={fieldErrors.title} hint={`${form.title.length}/60`}>
          <TextInput
            value={form.title}
            onChangeText={(v) => updateField('title', v)}
            placeholder="My awesome agent"
            placeholderTextColor="#9ca3af"
            maxLength={70}
            className={cn(
              'px-4 py-3 rounded-xl border bg-card text-foreground text-sm',
              fieldErrors.title ? 'border-destructive' : 'border-border',
            )}
          />
        </FormField>
        <FormField
          label="Short description"
          error={fieldErrors.shortDescription}
          hint={`${form.shortDescription.length}/160`}
          help="A one-liner shown on cards and search results."
        >
          <TextInput
            value={form.shortDescription}
            onChangeText={(v) => updateField('shortDescription', v)}
            placeholder="A brief summary of what this agent does"
            placeholderTextColor="#9ca3af"
            maxLength={170}
            className={cn(
              'px-4 py-3 rounded-xl border bg-card text-foreground text-sm',
              fieldErrors.shortDescription ? 'border-destructive' : 'border-border',
            )}
          />
        </FormField>
        <FormField label="Long description" help="Markdown bullets (`- text`) become a 'What's included' list on the detail page.">
          <TextInput
            value={form.longDescription}
            onChangeText={(v) => updateField('longDescription', v)}
            placeholder={`Detailed description of capabilities, use cases, and setup.\n\n- Auto-summarizes long emails\n- Drafts replies in your voice\n- Categorizes by sender`}
            placeholderTextColor="#9ca3af"
            multiline
            numberOfLines={8}
            textAlignVertical="top"
            className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm min-h-[160px]"
          />
        </FormField>
        <FormField label="Category" help="Helps buyers discover your agent when browsing by topic.">
          <View className="flex-row flex-wrap gap-2">
            {MARKETPLACE_CATEGORIES.map((cat) => (
              <Pressable
                key={cat.slug}
                onPress={() => updateField('category', cat.slug)}
                className={cn(
                  'px-3 py-2 rounded-xl border',
                  form.category === cat.slug
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-card',
                )}
              >
                <Text
                  className={cn(
                    'text-xs font-medium',
                    form.category === cat.slug ? 'text-primary' : 'text-foreground',
                  )}
                >
                  {cat.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </FormField>
      </Section>

      {/* Pricing */}
      <Section
        title="Pricing"
        subtitle="How buyers pay"
        done={sectionDone.pricing}
        open={openSections.pricing}
        onToggle={() => toggleSection('pricing')}
      >
        <View className="gap-2 mb-3">
          {PRICING_MODELS.map((pm) => (
            <Pressable
              key={pm.value}
              onPress={() => updateField('pricingModel', pm.value)}
              className={cn(
                'px-4 py-3 rounded-xl border',
                form.pricingModel === pm.value
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-card',
              )}
            >
              <Text
                className={cn(
                  'text-sm font-medium',
                  form.pricingModel === pm.value ? 'text-primary' : 'text-foreground',
                )}
              >
                {pm.label}
              </Text>
              <Text className="text-xs text-muted-foreground mt-0.5">
                {pm.description}
              </Text>
            </Pressable>
          ))}
        </View>

        {form.pricingModel === 'one_time' && (
          <FormField label="Price (USD)" error={fieldErrors.priceInCents}>
            <PriceInput
              value={form.priceInCents}
              onChange={(v) => updateField('priceInCents', v)}
              placeholder="9.99"
              error={!!fieldErrors.priceInCents}
            />
          </FormField>
        )}

        {form.pricingModel === 'subscription' && (
          <View className="gap-3">
            <FormField label="Monthly price (USD)" error={fieldErrors.monthlyPriceInCents}>
              <PriceInput
                value={form.monthlyPriceInCents}
                onChange={(v) => updateField('monthlyPriceInCents', v)}
                placeholder="4.99"
                error={!!fieldErrors.monthlyPriceInCents}
              />
            </FormField>
            <FormField
              label="Annual price (USD)"
              hint="Optional · enables side-by-side tier cards"
              help="Set both to surface 'Save X%' on the detail page."
            >
              <PriceInput
                value={form.annualPriceInCents}
                onChange={(v) => updateField('annualPriceInCents', v)}
                placeholder="49.99"
              />
            </FormField>
          </View>
        )}

        {/* Live pricing preview using PriceTag/PricingCards */}
        <View className="mt-4 rounded-xl border border-dashed border-border p-3 gap-3">
          <View className="flex-row items-center gap-2">
            <Eye size={12} color="#71717a" />
            <Text className="text-[11px] uppercase font-semibold text-muted-foreground" style={{ letterSpacing: 0.5 }}>
              Buyer sees
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <Text className="text-xs text-muted-foreground">CTA:</Text>
            <Text className="text-xs font-semibold text-foreground">
              {installCtaLabel(
                form.pricingModel,
                displayToCents(form.priceInCents),
                displayToCents(form.monthlyPriceInCents),
                displayToCents(form.annualPriceInCents),
              )}
            </Text>
            <View className="flex-1" />
            <PriceTag
              pricingModel={form.pricingModel}
              priceInCents={displayToCents(form.priceInCents)}
              monthlyPriceInCents={displayToCents(form.monthlyPriceInCents)}
              annualPriceInCents={displayToCents(form.annualPriceInCents)}
              size="md"
            />
          </View>
          {form.pricingModel === 'subscription' &&
            displayToCents(form.monthlyPriceInCents) > 0 &&
            displayToCents(form.annualPriceInCents) > 0 && (
              <PricingCards
                pricingModel="subscription"
                monthlyPriceInCents={displayToCents(form.monthlyPriceInCents)}
                annualPriceInCents={displayToCents(form.annualPriceInCents)}
              />
            )}
        </View>
      </Section>

      {/* Install model */}
      <Section
        title="Install model"
        subtitle="How buyers receive your agent"
        done={sectionDone.install}
        open={openSections.install}
        onToggle={() => toggleSection('install')}
      >
        <View className="gap-2">
          {INSTALL_MODELS.map((im) => (
            <Pressable
              key={im.value}
              onPress={() => updateField('installModel', im.value)}
              className={cn(
                'px-4 py-3 rounded-xl border flex-row items-start gap-3',
                form.installModel === im.value
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-card',
              )}
            >
              <View
                className={cn(
                  'w-4 h-4 rounded-full border-2 mt-0.5',
                  form.installModel === im.value
                    ? 'border-primary bg-primary'
                    : 'border-muted-foreground',
                )}
              />
              <View className="flex-1">
                <Text
                  className={cn(
                    'text-sm',
                    form.installModel === im.value
                      ? 'text-primary font-medium'
                      : 'text-foreground',
                  )}
                >
                  {im.label}
                </Text>
                <Text className="text-xs text-muted-foreground mt-0.5">
                  {im.description}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      </Section>

      {/* Tags & integrations */}
      <Section
        title="Tags & integrations"
        subtitle="Drives the 'Works with' strip and search"
        done={sectionDone.tags}
        open={openSections.tags}
        onToggle={() => toggleSection('tags')}
      >
        <FormField
          label="Tags"
          help="Tags matching known integrations (e.g. 'gmail', 'slack') get a tinted icon chip on the detail page."
        >
          {tagsArray.length > 0 && (
            <View className="flex-row flex-wrap gap-1.5 mb-2">
              {tagsArray.map((t) => (
                <View
                  key={t}
                  className={cn(
                    'flex-row items-center gap-1.5 rounded-full px-2.5 py-1',
                    KNOWN_INTEGRATIONS[t.toLowerCase()] ? 'bg-primary/15' : 'bg-muted',
                  )}
                >
                  <Text
                    className={cn(
                      'text-xs font-medium',
                      KNOWN_INTEGRATIONS[t.toLowerCase()]
                        ? 'text-primary'
                        : 'text-foreground',
                    )}
                  >
                    {KNOWN_INTEGRATIONS[t.toLowerCase()]?.label ?? t}
                  </Text>
                  <Pressable onPress={() => removeTag(t)} hitSlop={4}>
                    <X size={12} color="#71717a" />
                  </Pressable>
                </View>
              ))}
            </View>
          )}
          <TextInput
            value={form.tags}
            onChangeText={(v) => updateField('tags', v)}
            onFocus={() => setTagSuggestionFocus(true)}
            onBlur={() => setTimeout(() => setTagSuggestionFocus(false), 150)}
            placeholder="gmail, slack, automation, productivity"
            placeholderTextColor="#9ca3af"
            className="px-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm"
          />
          {tagSuggestionFocus && tagSuggestions.length > 0 && (
            <View className="mt-2">
              <Text className="text-[11px] text-muted-foreground mb-1.5">
                Known integrations
              </Text>
              <View className="flex-row flex-wrap gap-1.5">
                {tagSuggestions.map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => addTag(s)}
                    className="flex-row items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 active:opacity-70"
                  >
                    <Plus size={11} color="#71717a" />
                    <Text className="text-xs text-foreground">
                      {KNOWN_INTEGRATIONS[s].label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </FormField>
      </Section>

      {/* Publish status / actions */}
      <Section
        title="Publish"
        subtitle={
          existingStatus === 'published'
            ? 'Listing is live'
            : existingStatus === 'archived'
              ? 'Currently unlisted'
              : 'Save first, then publish'
        }
        done={sectionDone.publish}
        open={openSections.publish}
        onToggle={() => toggleSection('publish')}
      >
        {existingStatus && (
          <View className="rounded-xl border border-border bg-muted/30 px-4 py-3 mb-3">
            <Text className="text-xs font-semibold text-muted-foreground uppercase mb-1" style={{ letterSpacing: 0.4 }}>
              Status
            </Text>
            <View className="flex-row items-center gap-2">
              <View
                className={cn(
                  'w-2 h-2 rounded-full',
                  existingStatus === 'published'
                    ? 'bg-green-500'
                    : existingStatus === 'archived'
                      ? 'bg-red-500'
                      : 'bg-yellow-500',
                )}
              />
              <Text className="text-sm font-medium text-foreground capitalize">
                {existingStatus === 'archived' ? 'Unlisted' : existingStatus}
              </Text>
            </View>
          </View>
        )}
        <View className="flex-row items-start gap-2 px-3 py-2.5 rounded-xl bg-primary/5">
          <Info size={14} color="#e27927" style={{ marginTop: 1 }} />
          <Text className="text-xs text-foreground/80 flex-1 leading-4">
            Once published, your listing is visible on the marketplace. You can
            unlist it any time from this screen.
          </Text>
        </View>
      </Section>
    </ScrollView>
  )

  // ── Preview column ───────────────────────────────────────────────
  const previewColumn = (
    <View className="bg-muted/20 border-l border-border">
      <View className="flex-row items-center gap-2 px-5 pt-5 pb-3">
        <Eye size={14} color="#71717a" />
        <Text className="text-[11px] uppercase font-semibold text-muted-foreground flex-1" style={{ letterSpacing: 0.5 }}>
          Live preview
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32, gap: 16 }}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <Text className="text-[10px] uppercase text-muted-foreground mb-2" style={{ letterSpacing: 0.4 }}>
            Card
          </Text>
          <View className="max-w-[260px]">
            <AgentTile
              size="medium"
              listing={previewListing}
              onPress={() => {}}
            />
          </View>
        </View>
        <View>
          <Text className="text-[10px] uppercase text-muted-foreground mb-2" style={{ letterSpacing: 0.4 }}>
            Hero
          </Text>
          <View
            className="rounded-2xl overflow-hidden border border-border"
            style={{ backgroundColor: `${previewAccent}1a` }}
          >
            <View className="p-4 flex-row gap-3">
              <View
                className="rounded-xl items-center justify-center"
                style={{
                  width: 56,
                  height: 56,
                  backgroundColor: `${previewAccent}33`,
                }}
              >
                <Text style={{ color: previewAccent, fontSize: 24, fontWeight: '700' }}>
                  {previewInitial}
                </Text>
              </View>
              <View className="flex-1 min-w-0 gap-1.5">
                <Text className="text-base font-bold text-foreground" numberOfLines={2}>
                  {form.title || 'Untitled agent'}
                </Text>
                <Text className="text-xs text-foreground/70" numberOfLines={2}>
                  {form.shortDescription ||
                    'Add a short description to see it here.'}
                </Text>
                <View className="mt-1 flex-row items-center gap-2">
                  <PriceTag
                    pricingModel={form.pricingModel}
                    priceInCents={displayToCents(form.priceInCents)}
                    monthlyPriceInCents={displayToCents(form.monthlyPriceInCents)}
                    annualPriceInCents={displayToCents(form.annualPriceInCents)}
                  />
                  <CreatorChip
                    displayName="You"
                    tier="newcomer"
                    size="xs"
                    disablePress
                  />
                </View>
              </View>
            </View>
            <View className="px-4 pb-4">
              <View className="bg-primary rounded-xl py-2.5 items-center">
                <Text className="text-xs font-semibold text-primary-foreground">
                  {installCtaLabel(
                    form.pricingModel,
                    displayToCents(form.priceInCents),
                    displayToCents(form.monthlyPriceInCents),
                    displayToCents(form.annualPriceInCents),
                  )}
                </Text>
              </View>
            </View>
          </View>
        </View>
        <View>
          <Text className="text-[10px] uppercase text-muted-foreground mb-2" style={{ letterSpacing: 0.4 }}>
            Star rating preview
          </Text>
          <StarRating rating={4.5} size={14} />
        </View>
      </ScrollView>
    </View>
  )

  return (
    <View className="flex-1 bg-background">
      {/* Top bar */}
      <View className="flex-row items-center gap-3 px-5 pt-3 pb-2 border-b border-border">
        <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
          <ArrowLeft size={20} color="#71717a" />
        </Pressable>
        <Text className="text-base font-semibold text-foreground flex-1">
          {isNew ? 'New listing' : 'Edit listing'}
        </Text>
        {!isWide && (
          <Pressable
            onPress={() => setPreviewVisible((v) => !v)}
            hitSlop={6}
            className="p-1.5 active:opacity-60"
            accessibilityLabel="Toggle preview"
          >
            {previewVisible ? (
              <EyeOff size={18} color="#71717a" />
            ) : (
              <Eye size={18} color="#71717a" />
            )}
          </Pressable>
        )}
      </View>

      {/* Body */}
      <View className="flex-1 flex-row">
        <View style={{ flex: isWide ? 1 : undefined, width: isWide ? undefined : '100%' }}>
          {formColumn}
        </View>
        {isWide && <View style={{ width: 380 }}>{previewColumn}</View>}
      </View>

      {/* Stacked preview on narrow */}
      {!isWide && previewVisible && (
        <View className="border-t border-border bg-muted/30 max-h-[260px]">
          {previewColumn}
        </View>
      )}

      {/* Sticky save / publish bar */}
      <View
        className="flex-row items-center gap-2 px-5 py-3 border-t border-border bg-background"
        style={{
          shadowColor: '#000',
          shadowOpacity: 0.04,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: -4 },
          elevation: 8,
        }}
      >
        <Pressable
          onPress={handleSave}
          disabled={saving}
          className={cn(
            'flex-1 flex-row items-center justify-center gap-2 py-3 rounded-xl',
            saving ? 'bg-foreground/20' : 'bg-foreground/10 active:opacity-80',
          )}
        >
          {saving ? (
            <ActivityIndicator size="small" />
          ) : (
            <>
              <Save size={14} color="#71717a" />
              <Text className="text-sm font-semibold text-foreground">
                {isNew ? 'Save draft' : 'Save changes'}
              </Text>
            </>
          )}
        </Pressable>
        {!isNew && existingStatus === 'draft' && (
          <Pressable
            onPress={handlePublish}
            disabled={publishing || !sectionDone.basics}
            className={cn(
              'flex-1 flex-row items-center justify-center gap-2 py-3 rounded-xl',
              publishing || !sectionDone.basics ? 'bg-primary/60' : 'bg-primary',
            )}
          >
            {publishing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Send size={14} color="#fff" />
                <Text className="text-sm font-semibold text-primary-foreground">
                  Publish
                </Text>
              </>
            )}
          </Pressable>
        )}
        {!isNew && existingStatus === 'published' && (
          <Pressable
            onPress={handleUnlist}
            disabled={unlisting}
            className={cn(
              'flex-1 flex-row items-center justify-center gap-2 py-3 rounded-xl',
              unlisting ? 'bg-destructive/40' : 'bg-destructive/15 active:opacity-80',
            )}
          >
            {unlisting ? (
              <ActivityIndicator size="small" color="#dc2626" />
            ) : (
              <>
                <EyeOff size={14} color="#dc2626" />
                <Text className="text-sm font-semibold text-destructive">Unlist</Text>
              </>
            )}
          </Pressable>
        )}
      </View>
    </View>
  )
})

// ── Sub-components ─────────────────────────────────────────────────

function Section({
  title,
  subtitle,
  done,
  open,
  onToggle,
  children,
}: {
  title: string
  subtitle?: string
  done?: boolean
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <View className="rounded-2xl border border-border bg-card overflow-hidden mb-4">
      <Pressable
        onPress={onToggle}
        className="flex-row items-center gap-3 px-4 py-3 active:bg-muted/40"
      >
        <View
          className={cn(
            'w-6 h-6 rounded-full items-center justify-center',
            done ? 'bg-emerald-500/15' : 'bg-muted',
          )}
        >
          {done ? (
            <Check size={12} color="#16a34a" />
          ) : (
            <View className="w-2 h-2 rounded-full bg-muted-foreground/50" />
          )}
        </View>
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-semibold text-foreground">{title}</Text>
          {subtitle && (
            <Text className="text-[11px] text-muted-foreground">{subtitle}</Text>
          )}
        </View>
        <ChevronDown
          size={16}
          color="#71717a"
          style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
        />
      </Pressable>
      {open && (
        <View className="px-4 pb-4 gap-4 border-t border-border">{children}</View>
      )}
    </View>
  )
}

function FormField({
  label,
  hint,
  error,
  help,
  children,
}: {
  label: string
  hint?: string
  error?: string
  help?: string
  children: React.ReactNode
}) {
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between">
        <Text className="text-xs font-semibold text-foreground">{label}</Text>
        {hint && !error && (
          <Text className="text-[10px] text-muted-foreground">{hint}</Text>
        )}
        {error && (
          <Text className="text-[10px] font-medium text-destructive">{error}</Text>
        )}
      </View>
      {children}
      {help && (
        <Text className="text-[11px] text-muted-foreground leading-4">{help}</Text>
      )}
    </View>
  )
}

function PriceInput({
  value,
  onChange,
  placeholder,
  error,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  error?: boolean
}) {
  return (
    <View
      className={cn(
        'flex-row items-center px-3 rounded-xl border bg-card',
        error ? 'border-destructive' : 'border-border',
      )}
    >
      <Text className="text-foreground text-sm font-medium mr-1">$</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#9ca3af"
        keyboardType="decimal-pad"
        className="flex-1 py-3 text-foreground text-sm"
      />
    </View>
  )
}
