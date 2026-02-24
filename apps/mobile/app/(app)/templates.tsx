import { useState, useMemo, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { Database, LayoutDashboard } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import {
  useWorkspaceCollection,
  useProjectCollection,
  useDomainActions,
} from '../../contexts/domain'

interface CanvasTemplate {
  id: string
  user_request: string
  needs_api_schema: boolean
  component_types: string[]
  component_count: number
}

function formatTemplateName(id: string): string {
  return id
    .replace(/-crud$/, '')
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

const TEMPLATE_TAGLINES: Record<string, string> = {
  'weather-display': 'Live weather forecast',
  'flight-search': 'Search & pick flights',
  'email-dashboard': 'Metrics, tabs & email tables',
  'analytics-dashboard': 'Revenue charts & top products',
  'research-report': 'Expandable sections & progress',
  'counter': 'Simple interactive counter',
  'task-tracker-crud': 'Add, complete & delete tasks',
  'stock-dashboard-crud': 'Portfolio & price tracking',
  'meeting-scheduler': 'Date/time pickers & submit',
  'notification-feed': 'PR reviews, builds & reminders',
  'crm-pipeline': 'Leads across pipeline stages',
  'expense-dashboard': 'Spend, budgets & recent expenses',
  'cicd-monitor': 'Deploy status & frequency',
  'support-tickets-crud': 'Priority levels & status tracking',
  'invoice-tracker-crud': 'Clients, amounts & due dates',
  'hr-pipeline-crud': 'Applicants, stages & ratings',
  'social-media-dashboard': 'Followers, trends & posts',
  'ecommerce-orders-crud': 'Order metrics & status',
}

const TEMPLATE_ICONS: Record<string, string> = {
  'weather-display': '\u{1F324}\u{FE0F}',
  'flight-search': '\u{2708}\u{FE0F}',
  'email-dashboard': '\u{1F4E7}',
  'analytics-dashboard': '\u{1F4CA}',
  'research-report': '\u{1F4D1}',
  'counter': '\u{1F522}',
  'task-tracker-crud': '\u{2705}',
  'stock-dashboard-crud': '\u{1F4C8}',
  'meeting-scheduler': '\u{1F4C5}',
  'notification-feed': '\u{1F514}',
  'crm-pipeline': '\u{1F91D}',
  'expense-dashboard': '\u{1F4B0}',
  'cicd-monitor': '\u{1F680}',
  'support-tickets-crud': '\u{1F3AB}',
  'invoice-tracker-crud': '\u{1F9FE}',
  'hr-pipeline-crud': '\u{1F465}',
  'social-media-dashboard': '\u{1F4F1}',
  'ecommerce-orders-crud': '\u{1F6D2}',
}

const CANVAS_TEMPLATES: CanvasTemplate[] = [
  {
    id: 'analytics-dashboard',
    user_request: 'Create a sales analytics dashboard with revenue chart and top products',
    needs_api_schema: false,
    component_types: ['Column', 'Row', 'Text', 'Badge', 'Grid', 'Metric', 'Card', 'Chart', 'Table'],
    component_count: 12,
  },
  {
    id: 'task-tracker-crud',
    user_request: 'Build a task tracker where I can add, complete, and delete tasks',
    needs_api_schema: true,
    component_types: ['Column', 'Card', 'Table', 'Button', 'TextField'],
    component_count: 8,
  },
  {
    id: 'email-dashboard',
    user_request: 'Build an email dashboard with metrics, tabs, and email tables',
    needs_api_schema: false,
    component_types: ['Column', 'Grid', 'Metric', 'Separator', 'Tabs', 'Table', 'Alert', 'Text'],
    component_count: 14,
  },
  {
    id: 'crm-pipeline',
    user_request: 'Build a CRM pipeline canvas showing leads in 3 stages: New, Qualified, Closed with lead details',
    needs_api_schema: false,
    component_types: ['Column', 'Grid', 'Card', 'Text', 'Badge', 'Metric'],
    component_count: 12,
  },
  {
    id: 'support-tickets-crud',
    user_request: 'Build a support ticket management app with CRUD API, priority levels, and status tracking',
    needs_api_schema: true,
    component_types: ['Column', 'Table', 'Button', 'Badge'],
    component_count: 8,
  },
  {
    id: 'expense-dashboard',
    user_request: 'Create an expense tracker dashboard with total spend, budget remaining, and a table of recent expenses',
    needs_api_schema: false,
    component_types: ['Column', 'Row', 'Metric', 'Table', 'Badge'],
    component_count: 8,
  },
  {
    id: 'stock-dashboard-crud',
    user_request: 'Create a stock portfolio dashboard with price tracking',
    needs_api_schema: true,
    component_types: ['Column', 'Grid', 'Metric', 'Card', 'Table', 'Chart'],
    component_count: 10,
  },
  {
    id: 'ecommerce-orders-crud',
    user_request: 'Build an order management dashboard with CRUD showing order metrics, order table with status, and seed data',
    needs_api_schema: true,
    component_types: ['Column', 'Row', 'Metric', 'Table', 'Badge', 'Button'],
    component_count: 12,
  },
  {
    id: 'meeting-scheduler',
    user_request: 'Create a meeting scheduler with date/time pickers and a submit button',
    needs_api_schema: false,
    component_types: ['Card', 'Column', 'TextField', 'Select', 'ChoicePicker', 'Row', 'Button'],
    component_count: 9,
  },
  {
    id: 'notification-feed',
    user_request: 'Show a notification feed with PR reviews, build failures, and meeting reminders',
    needs_api_schema: false,
    component_types: ['Column', 'Text', 'DataList', 'Card', 'Row', 'Badge'],
    component_count: 7,
  },
  {
    id: 'cicd-monitor',
    user_request: 'Build a CI/CD pipeline monitor showing recent deploys with status and a deploy frequency chart',
    needs_api_schema: false,
    component_types: ['Column', 'Card', 'Table', 'Badge', 'Text', 'Chart'],
    component_count: 10,
  },
  {
    id: 'social-media-dashboard',
    user_request: 'Build a social media analytics dashboard with follower/engagement metrics, trends chart, and scheduled posts table',
    needs_api_schema: false,
    component_types: ['Column', 'Row', 'Grid', 'Metric', 'Chart', 'Table', 'Badge'],
    component_count: 14,
  },
  {
    id: 'invoice-tracker-crud',
    user_request: 'Build an invoice tracker with CRUD API, client name, amount, due date, status, and total metric',
    needs_api_schema: true,
    component_types: ['Column', 'Metric', 'Table', 'Badge', 'Button'],
    component_count: 9,
  },
  {
    id: 'hr-pipeline-crud',
    user_request: 'Create a recruiting pipeline app tracking applicants with name, position, stage, rating, and notes',
    needs_api_schema: true,
    component_types: ['Column', 'Table', 'Badge', 'Text', 'Button'],
    component_count: 8,
  },
  {
    id: 'research-report',
    user_request: 'Build a research report on the EV market with progress tracking and expandable sections',
    needs_api_schema: false,
    component_types: ['Column', 'Row', 'Text', 'Badge', 'Card', 'Chart', 'Accordion', 'AccordionItem', 'Grid', 'Metric', 'Table', 'Alert'],
    component_count: 17,
  },
  {
    id: 'weather-display',
    user_request: 'Show me the current weather forecast',
    needs_api_schema: false,
    component_types: ['Column', 'Text', 'Badge'],
    component_count: 4,
  },
  {
    id: 'flight-search',
    user_request: 'Find flights from SFO to JFK and let me pick one',
    needs_api_schema: false,
    component_types: ['Column', 'Text', 'Card', 'Button'],
    component_count: 6,
  },
]

function TemplateCard({
  template,
  isLoading,
  onPress,
}: {
  template: CanvasTemplate
  isLoading: boolean
  onPress: () => void
}) {
  const tagline = TEMPLATE_TAGLINES[template.id] ?? template.user_request.slice(0, 50)
  const icon = TEMPLATE_ICONS[template.id] ?? '\u{1F9E9}'

  return (
    <Pressable
      onPress={onPress}
      disabled={isLoading}
      className={cn(
        'flex-1 mx-1.5 mb-3 rounded-xl p-4 border border-border/50 bg-card/60',
        isLoading && 'opacity-50'
      )}
    >
      <View className="flex-row items-start gap-3">
        <Text className="text-2xl mt-0.5">{icon}</Text>
        <View className="flex-1">
          <Text className="text-foreground font-semibold text-[15px] leading-tight">
            {formatTemplateName(template.id)}
          </Text>
          <Text className="text-muted-foreground text-sm mt-1" numberOfLines={2}>
            {tagline}
          </Text>
        </View>
      </View>

      <View className="flex-row items-center gap-2 mt-3">
        {template.needs_api_schema ? (
          <View className="flex-row items-center gap-1 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5">
            <Database size={12} className="text-blue-400" />
            <Text className="text-blue-400 text-[11px] font-medium">CRUD</Text>
          </View>
        ) : (
          <View className="flex-row items-center gap-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2 py-0.5">
            <LayoutDashboard size={12} className="text-emerald-400" />
            <Text className="text-emerald-400 text-[11px] font-medium">Display</Text>
          </View>
        )}
        <Text className="text-muted-foreground text-[11px]">
          {template.component_count} components
        </Text>
      </View>

      {isLoading && (
        <View className="absolute inset-0 bg-background/60 items-center justify-center rounded-xl">
          <ActivityIndicator size="small" />
        </View>
      )}
    </Pressable>
  )
}

export default observer(function TemplatesPage() {
  const router = useRouter()
  const { user } = useAuth()
  const actions = useDomainActions()
  const workspaces = useWorkspaceCollection()
  const projects = useProjectCollection()

  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)

  const currentWorkspace = workspaces.all.length > 0 ? workspaces.all[0] : null

  const handleTemplatePress = useCallback(
    async (template: CanvasTemplate) => {
      if (!user?.id || !currentWorkspace?.id) {
        Alert.alert('Error', 'No user session or workspace available')
        return
      }

      setLoadingTemplate(template.id)

      try {
        const displayName = formatTemplateName(template.id)
        const project = await actions.createProject(
          displayName,
          currentWorkspace.id,
          undefined,
          user.id,
          'AGENT'
        )

        if (project?.id) {
          projects.loadAll()
          router.push({
            pathname: '/(app)/projects/[id]',
            params: { id: project.id, initialMessage: template.user_request },
          })
        }
      } catch (error) {
        console.error('[TemplatesPage] Failed to create project:', error)
        Alert.alert('Error', 'Failed to create project from template')
      } finally {
        setLoadingTemplate(null)
      }
    },
    [user?.id, currentWorkspace?.id, actions, projects, router]
  )

  const templates = useMemo(() => CANVAS_TEMPLATES, [])

  const renderItem = useCallback(
    ({ item }: { item: CanvasTemplate }) => (
      <TemplateCard
        template={item}
        isLoading={loadingTemplate === item.id}
        onPress={() => handleTemplatePress(item)}
      />
    ),
    [loadingTemplate, handleTemplatePress]
  )

  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* Header */}
      <View className="px-4 pt-4 pb-2">
        <Text className="text-foreground text-2xl font-semibold">Canvas Templates</Text>
        <Text className="text-muted-foreground mt-1">
          Start from a template — tap to create a project with this prompt
        </Text>
      </View>

      {/* Templates Grid */}
      <FlatList
        data={templates}
        keyExtractor={(item) => item.id}
        numColumns={2}
        contentContainerClassName="px-2.5 pt-2 pb-6"
        renderItem={renderItem}
      />
    </SafeAreaView>
  )
})
