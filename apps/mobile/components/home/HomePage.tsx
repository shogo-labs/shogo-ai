// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback } from 'react'
import { View, ScrollView, useWindowDimensions, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { Sparkles, ChevronRight } from 'lucide-react-native'
import { Heading } from '@/components/ui/heading'
import { Text } from '@/components/ui/text'
import { Button, ButtonText, ButtonIcon } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@shogo/shared-ui/primitives'
import { CompactChatInput } from '@/components/chat/CompactChatInput'
import { TemplateCard, formatTemplateName } from './TemplateCard'
import { TemplatePreviewModal } from './TemplatePreviewModal'
import { useTemplates, type CanvasTemplate } from '@/hooks/useTemplates'

interface HomePageProps {
  userName?: string
  onPromptSubmit?: (prompt: string, imageData?: string[]) => void
  onTemplateSelect?: (templateName: string, displayName: string, prompt: string) => void
  isLoading?: boolean
  loadingTemplate?: string | null
}

export const HomePage = observer(function HomePage({
  userName = 'there',
  onPromptSubmit,
  onTemplateSelect,
  isLoading = false,
  loadingTemplate = null,
}: HomePageProps) {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const [prompt, setPrompt] = useState('')

  const { templates, isLoading: isLoadingTemplates } = useTemplates()

  const [selectedTemplate, setSelectedTemplate] = useState<CanvasTemplate | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)

  const firstName = userName.split(' ')[0] || 'there'

  const numColumns = width >= 1024 ? 3 : width >= 640 ? 2 : 1

  const handleTemplateClick = useCallback((template: CanvasTemplate) => {
    setSelectedTemplate(template)
    setIsModalOpen(true)
  }, [])

  const handleUseTemplate = useCallback((template: CanvasTemplate) => {
    if (onTemplateSelect && !loadingTemplate) {
      onTemplateSelect(
        template.id,
        formatTemplateName(template.id),
        template.user_request,
      )
      setIsModalOpen(false)
    }
  }, [onTemplateSelect, loadingTemplate])

  const handleSubmit = useCallback((text: string, imageData?: string[]) => {
    onPromptSubmit?.(text, imageData)
  }, [onPromptSubmit])

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-grow"
        showsVerticalScrollIndicator={false}
      >
        {/* Gradient background orbs */}
        <View className="absolute inset-0 overflow-hidden" pointerEvents="none">
          <View
            className="absolute w-[500px] h-[500px] rounded-full opacity-20"
            style={Platform.select({
              web: {
                background: 'radial-gradient(circle, rgba(59, 130, 246, 0.6) 0%, rgba(139, 92, 246, 0.5) 40%, rgba(236, 72, 153, 0.4) 100%)',
                filter: 'blur(120px)',
                top: '10%',
                left: '20%',
              } as any,
              default: {
                backgroundColor: 'rgba(99, 102, 241, 0.25)',
                top: '5%',
                left: '5%',
              },
            })}
          />
          <View
            className="absolute w-[400px] h-[400px] rounded-full opacity-20"
            style={Platform.select({
              web: {
                background: 'radial-gradient(circle, rgba(249, 115, 22, 0.5) 0%, rgba(236, 72, 153, 0.5) 50%, rgba(139, 92, 246, 0.3) 100%)',
                filter: 'blur(100px)',
                bottom: '5%',
                right: '10%',
              } as any,
              default: {
                backgroundColor: 'rgba(236, 72, 153, 0.2)',
                bottom: '10%',
                right: '0%',
              },
            })}
          />
          <View
            className="absolute w-[350px] h-[350px] rounded-full opacity-15"
            style={Platform.select({
              web: {
                background: 'radial-gradient(circle, rgba(34, 211, 238, 0.3) 0%, rgba(59, 130, 246, 0.3) 100%)',
                filter: 'blur(100px)',
                top: '50%',
                right: '30%',
              } as any,
              default: {
                backgroundColor: 'rgba(34, 211, 238, 0.2)',
                top: '40%',
                right: '20%',
              },
            })}
          />
          <View
            className="absolute w-[300px] h-[300px] rounded-full opacity-15"
            style={Platform.select({
              web: {
                background: 'radial-gradient(circle, rgba(236, 72, 153, 0.5) 0%, rgba(168, 85, 247, 0.3) 100%)',
                filter: 'blur(80px)',
                top: '30%',
                left: '50%',
                transform: 'translateX(-50%)',
              } as any,
              default: {
                backgroundColor: 'rgba(168, 85, 247, 0.2)',
                top: '25%',
                left: '30%',
              },
            })}
          />
        </View>

        {/* Hero section */}
        <View className="relative items-center justify-center px-6 pt-16 pb-8" style={{ minHeight: width >= 768 ? 400 : 320 }}>
          <Heading
            size="3xl"
            className="text-center mb-8 text-typography-900"
          >
            What's on your mind, {firstName}?
          </Heading>

          <View className="w-full max-w-2xl">
            <CompactChatInput
              onSubmit={handleSubmit}
              disabled={isLoading}
              isLoading={isLoading}
              value={prompt}
              onChange={setPrompt}
            />
          </View>

          {/* Quick suggestions */}
          <View className="mt-6 flex-row flex-wrap justify-center gap-2 px-2">
            {[
              'Build a customer support agent',
              'Create a research assistant',
              'Make a scheduling agent',
              'Design a data analysis agent',
            ].map((suggestion) => (
              <Button
                key={suggestion}
                variant="outline"
                size="xs"
                action="secondary"
                onPress={() => setPrompt(suggestion)}
                className="border-border/50 bg-card/50"
              >
                <ButtonIcon as={Sparkles} className="text-purple-400" height={12} width={12} />
                <ButtonText className="text-xs text-typography-700">{suggestion}</ButtonText>
              </Button>
            ))}
          </View>
        </View>

        {/* Canvas templates section */}
        <View className="bg-card/30 border-t border-border py-6">
          <View className="flex-row items-center justify-between mb-4 px-6">
            <Text className="text-sm font-medium text-typography-900">Canvas Templates</Text>
            <Button
              variant="link"
              size="xs"
              action="secondary"
              onPress={() => router.push('/(app)/templates' as any)}
            >
              <ButtonText className="text-sm text-typography-500">Browse all</ButtonText>
              <ButtonIcon as={ChevronRight} className="text-typography-500" height={16} width={16} />
            </Button>
          </View>

          {isLoadingTemplates ? (
            <View className="items-center justify-center py-8">
              <Spinner className="text-typography-400" />
            </View>
          ) : templates.length === 0 ? (
            <View className="items-center gap-3 py-8 px-6">
              <Text className="text-sm text-typography-500 text-center">
                No templates available right now.
              </Text>
              <Text className="text-xs text-typography-500 text-center">
                Start a conversation above to create your agent from scratch — just describe what you want to build.
              </Text>
            </View>
          ) : (
            <View className="px-6 pb-6">
              <View
                className="flex-row flex-wrap mx-auto"
                style={{ maxWidth: 1024, gap: 12 }}
              >
                {templates.slice(0, 6).map((template) => (
                  <View
                    key={template.id}
                    style={{
                      width: numColumns === 1
                        ? '100%'
                        : numColumns === 2
                          ? `${(100 - 2) / 2}%`
                          : `${(100 - 4) / 3}%`,
                    }}
                  >
                    <TemplateCard
                      template={template}
                      isLoading={loadingTemplate === template.id}
                      onPress={() => handleTemplateClick(template)}
                    />
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Template Preview Modal */}
      <TemplatePreviewModal
        template={selectedTemplate}
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        onUseTemplate={handleUseTemplate}
        isLoading={loadingTemplate !== null}
      />
    </View>
  )
})
