import { View } from 'react-native'
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal'
import { Heading } from '@/components/ui/heading'
import { Text } from '@/components/ui/text'
import { Button, ButtonText, ButtonSpinner, ButtonIcon } from '@/components/ui/button'
import { Sparkles, X, Database, LayoutDashboard } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { formatTemplateName } from './TemplateCard'
import type { CanvasTemplate } from '@/hooks/useTemplates'

interface TemplatePreviewModalProps {
  template: CanvasTemplate | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onUseTemplate: (template: CanvasTemplate) => void
  isLoading?: boolean
}

const COMPONENT_LABELS: Record<string, { label: string; color: string }> = {
  Chart: { label: "Charts", color: "bg-violet-500/10 text-violet-400 border-violet-500/20" },
  Table: { label: "Tables", color: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  Metric: { label: "Metrics", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  Card: { label: "Cards", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  Tabs: { label: "Tabs", color: "bg-pink-500/10 text-pink-400 border-pink-500/20" },
  DataList: { label: "Data List", color: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20" },
  Accordion: { label: "Accordion", color: "bg-orange-500/10 text-orange-400 border-orange-500/20" },
  Button: { label: "Buttons", color: "bg-rose-500/10 text-rose-400 border-rose-500/20" },
  TextField: { label: "Text Fields", color: "bg-sky-500/10 text-sky-400 border-sky-500/20" },
  Select: { label: "Selects", color: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20" },
  Checkbox: { label: "Checkboxes", color: "bg-lime-500/10 text-lime-400 border-lime-500/20" },
  Badge: { label: "Badges", color: "bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20" },
  Progress: { label: "Progress", color: "bg-teal-500/10 text-teal-400 border-teal-500/20" },
  Alert: { label: "Alerts", color: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20" },
  Image: { label: "Images", color: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
  ChoicePicker: { label: "Choice Picker", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
}

const LAYOUT_TYPES = new Set(["Column", "Row", "Grid", "ScrollArea"])

export function TemplatePreviewModal({
  template,
  open,
  onOpenChange,
  onUseTemplate,
  isLoading = false,
}: TemplatePreviewModalProps) {
  if (!template) return null

  const displayComponents = template.component_types.filter(
    (c) => !LAYOUT_TYPES.has(c) && c !== "Text" && c !== "Separator" && c !== "AccordionItem" && c !== "TabPanel"
  )

  return (
    <Modal isOpen={open} onClose={() => onOpenChange(false)} size="lg">
      <ModalBackdrop />
      <ModalContent className="bg-background-0 p-0">
        <ModalHeader className="px-6 pt-6 pb-4 border-b border-outline-100">
          <Heading size="xl" className="text-typography-900">
            {formatTemplateName(template.id)}
          </Heading>
          <ModalCloseButton>
            <X size={20} className="text-typography-500" />
          </ModalCloseButton>
        </ModalHeader>

        <ModalBody className="px-6 py-5" contentContainerClassName="gap-5">
          {/* Prompt preview */}
          <View>
            <Text className="text-xs font-medium text-typography-500 uppercase tracking-widest mb-2">
              Prompt
            </Text>
            <View className="bg-background-50 rounded-lg px-4 py-3 border border-outline-100">
              <Text className="text-sm text-typography-900 leading-relaxed">
                "{template.user_request}"
              </Text>
            </View>
          </View>

          {/* Type badge */}
          <View>
            <Text className="text-xs font-medium text-typography-500 uppercase tracking-widest mb-2">
              Type
            </Text>
            <View className="flex-row items-center gap-2">
              {template.needs_api_schema ? (
                <View className="flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20">
                  <Database size={14} className="text-blue-400" />
                  <Text className="text-xs font-medium text-blue-400">
                    CRUD App
                  </Text>
                </View>
              ) : (
                <View className="flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                  <LayoutDashboard size={14} className="text-emerald-400" />
                  <Text className="text-xs font-medium text-emerald-400">
                    Display
                  </Text>
                </View>
              )}
            </View>
          </View>

          {/* Components */}
          {displayComponents.length > 0 && (
            <View>
              <Text className="text-xs font-medium text-typography-500 uppercase tracking-widest mb-2">
                Components ({template.component_count} total)
              </Text>
              <View className="flex-row flex-wrap gap-1.5">
                {displayComponents.map((comp) => {
                  const info = COMPONENT_LABELS[comp]
                  return (
                    <View
                      key={comp}
                      className={cn(
                        'px-2 py-0.5 rounded-full border',
                        info?.color ?? 'bg-background-50 text-typography-500 border-outline-200'
                      )}
                    >
                      <Text className={cn(
                        'text-[11px] font-medium',
                        info?.color?.split(' ').find(c => c.startsWith('text-')) ?? 'text-typography-500'
                      )}>
                        {info?.label ?? comp}
                      </Text>
                    </View>
                  )
                })}
              </View>
            </View>
          )}
        </ModalBody>

        <ModalFooter className="px-6 py-4 border-t border-outline-100 justify-end">
          <Button
            onPress={() => onUseTemplate(template)}
            isDisabled={isLoading}
            action="primary"
          >
            {isLoading ? (
              <ButtonSpinner className="text-typography-0" />
            ) : (
              <ButtonIcon as={Sparkles} className="text-typography-0" />
            )}
            <ButtonText>{isLoading ? 'Creating...' : 'Use template'}</ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
