// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CompactChatInput Component (React Native)
 *
 * Chat input card with attach button and send button.
 * Supports file attachments via image picker.
 *
 * Note: ThemeSelector is omitted for mobile (web-only feature).
 * File handling uses expo-image-picker instead of HTML file input.
 * Drag-and-drop is omitted (not available on mobile).
 */

import { useState, useRef, useCallback, forwardRef, useEffect } from "react"
import { View, Text, TextInput, Pressable, Image, ScrollView, Platform } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Paperclip, Send, Loader2, X, File, FileText, ImageIcon, Bot, AppWindow, ChevronDown } from "lucide-react-native"
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
} from "@/components/ui/popover"
import type { FileAttachment } from "./ChatInput"

export type ProjectType = "APP" | "AGENT"

const PROJECT_TYPE_OPTIONS: { id: ProjectType; label: string; description: string; Icon: React.ElementType }[] = [
  { id: "AGENT", label: "Agent", description: "Autonomous AI agent with tools & integrations", Icon: Bot },
  { id: "APP", label: "App", description: "Full-stack web application with live preview", Icon: AppWindow },
]

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_FILES = 10

interface AttachedFile {
  id: string
  dataUrl: string
  name: string
  type: string
  size: number
}

export interface CompactChatInputProps {
  onSubmit: (prompt: string, files?: FileAttachment[]) => void
  disabled?: boolean
  isLoading?: boolean
  placeholder?: string
  className?: string
  value?: string
  onChange?: (value: string) => void
  projectType?: ProjectType
  onProjectTypeChange?: (type: ProjectType) => void
}

export const CompactChatInput = forwardRef<View, CompactChatInputProps>(
  function CompactChatInput(
    {
      onSubmit,
      disabled = false,
      isLoading = false,
      placeholder: placeholderProp,
      className,
      value: controlledValue,
      onChange: controlledOnChange,
      projectType: controlledProjectType,
      onProjectTypeChange,
    },
    ref
  ) {
    const [internalValue, setInternalValue] = useState("")
    const textInputRef = useRef<TextInput>(null)
    const [typeMenuOpen, setTypeMenuOpen] = useState(false)
    const [internalProjectType, setInternalProjectType] = useState<ProjectType>("AGENT")
    const projectType = controlledProjectType ?? internalProjectType
    const currentTypeConfig = PROJECT_TYPE_OPTIONS.find((o) => o.id === projectType) ?? PROJECT_TYPE_OPTIONS[0]

    const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
    const [fileError, setFileError] = useState<string | null>(null)
    const fileInputRef = useRef<HTMLInputElement | null>(null)
    const dropZoneRef = useRef<View>(null)

    const value = controlledValue ?? internalValue
    const setValue = controlledOnChange ?? setInternalValue

    const placeholderText = placeholderProp ?? "Describe the agent you want to build..."

    const formatFileSize = useCallback((bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }, [])

    const handleRemoveFile = useCallback((fileId: string) => {
      setPendingFiles((prev) => prev.filter((f) => f.id !== fileId))
      setFileError(null)
    }, [])

    const handleSubmit = useCallback(() => {
      const trimmedContent = value.trim()
      if ((!trimmedContent && pendingFiles.length === 0) || disabled || isLoading) return

      const fileData: FileAttachment[] | undefined =
        pendingFiles.length > 0
          ? pendingFiles.map((f) => ({ dataUrl: f.dataUrl, name: f.name, type: f.type }))
          : undefined

      onSubmit(trimmedContent, fileData)
      setFileError(null)
    }, [value, disabled, isLoading, onSubmit, pendingFiles])

    const handleAttachClick = useCallback(() => {
      if (Platform.OS === "web") {
        fileInputRef.current?.click()
      }
    }, [])

    const processFiles = useCallback(
      (files: FileList | File[]) => {
        Array.from(files).forEach((file: File) => {
          if (file.size > MAX_FILE_SIZE) {
            setFileError(`File "${file.name}" exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`)
            return
          }
          if (pendingFiles.length >= MAX_FILES) {
            setFileError(`Maximum ${MAX_FILES} files allowed`)
            return
          }
          const reader = new FileReader()
          reader.onload = () => {
            const dataUrl = reader.result as string
            setPendingFiles((prev) => [
              ...prev,
              {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                dataUrl,
                name: file.name,
                type: file.type,
                size: file.size,
              },
            ])
            setFileError(null)
          }
          reader.readAsDataURL(file)
        })
      },
      [pendingFiles]
    )

    const handleWebFileChange = useCallback(
      (e: any) => {
        const files = e.target?.files
        if (!files || files.length === 0) return
        processFiles(files)
        if (e.target) e.target.value = ""
      },
      [processFiles]
    )

    useEffect(() => {
      if (Platform.OS !== "web") return
      const node = dropZoneRef.current as unknown as HTMLElement | null
      if (!node) return

      const handleDragOver = (e: DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
      }
      const handleDrop = (e: DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer?.files?.length) {
          processFiles(Array.from(e.dataTransfer.files) as any)
        }
      }

      node.addEventListener("dragover", handleDragOver)
      node.addEventListener("drop", handleDrop)
      return () => {
        node.removeEventListener("dragover", handleDragOver)
        node.removeEventListener("drop", handleDrop)
      }
    }, [processFiles])

    const getFileIcon = useCallback((fileType: string) => {
      if (fileType.startsWith("image/")) {
        return <ImageIcon className="h-4 w-4 text-gray-400" size={16} />
      }
      if (
        fileType.includes("pdf") ||
        fileType.includes("document") ||
        fileType.includes("text")
      ) {
        return <FileText className="h-4 w-4 text-gray-400" size={16} />
      }
      return <File className="h-4 w-4 text-gray-400" size={16} />
    }, [])

    return (
      <View ref={ref} className={cn("w-full", className)}>
        <View ref={dropZoneRef as any} className="bg-white/80 dark:bg-gray-900/80 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          {/* Hidden file input for web */}
          {Platform.OS === "web" && (
            <input
              ref={fileInputRef as any}
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.md,.csv,.json"
              onChange={handleWebFileChange}
              style={{ display: "none" }}
            />
          )}

          {/* File previews */}
          {pendingFiles.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-2 p-4 pb-2"
            >
              {pendingFiles.map((file) => {
                const isImage = file.type.startsWith("image/")
                return (
                  <View
                    key={file.id}
                    className={cn(
                      "relative rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-100/50 dark:bg-gray-800/50 p-2",
                      isImage ? "w-[150px]" : "w-[180px]"
                    )}
                  >
                    {isImage ? (
                      <Image
                        source={{ uri: file.dataUrl }}
                        className="h-[80px] rounded border border-gray-200 dark:border-gray-700 w-full"
                        resizeMode="cover"
                      />
                    ) : (
                      <View className="flex-row items-center gap-2">
                        {getFileIcon(file.type)}
                        <View className="flex-1 min-w-0">
                          <Text
                            className="text-xs font-medium text-foreground"
                            numberOfLines={1}
                          >
                            {file.name}
                          </Text>
                          <Text className="text-xs text-gray-400">
                            {formatFileSize(file.size)}
                          </Text>
                        </View>
                      </View>
                    )}
                    <Pressable
                      onPress={() => handleRemoveFile(file.id)}
                      className="absolute -right-1 -top-1 h-6 w-6 rounded-full bg-red-500 items-center justify-center"
                    >
                      <X className="h-3 w-3 text-white" size={12} />
                    </Pressable>
                  </View>
                )
              })}
            </ScrollView>
          )}

          {/* Error message */}
          {fileError && (
            <Text className="text-sm text-red-500 px-4 pb-2">{fileError}</Text>
          )}

          {/* Input area */}
          <View className="p-4">
            <TextInput
              ref={textInputRef}
              placeholder={placeholderText}
              placeholderTextColor="#9ca3af"
              value={value}
              onChangeText={setValue}
              onSubmitEditing={handleSubmit}
              onKeyPress={(e: any) => {
                if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
              editable={!disabled && !isLoading}
              multiline
              className="min-h-[80px] text-base text-foreground"
              textAlignVertical="top"
              style={Platform.OS === 'web' ? { outlineStyle: 'none', caretColor: 'auto' } as any : undefined}
            />
          </View>

          {/* Action bar */}
          <View className="px-4 pb-4 flex-row items-center justify-between gap-2">
            <View className="flex-row items-center gap-1">
              <Pressable
                onPress={handleAttachClick}
                className="h-8 flex-row items-center gap-1.5 px-2"
                disabled={disabled || isLoading || pendingFiles.length >= MAX_FILES}
              >
                <Paperclip className="h-4 w-4 text-gray-400" size={16} />
                <Text className="text-xs text-gray-400">Attach</Text>
              </Pressable>

              {/* Project type selector */}
              <Popover
                placement="top"
                size="xs"
                isOpen={typeMenuOpen}
                onOpen={() => setTypeMenuOpen(true)}
                onClose={() => setTypeMenuOpen(false)}
                trigger={(triggerProps) => (
                  <Pressable
                    {...triggerProps}
                    disabled={disabled || isLoading}
                    className="h-8 flex-row items-center gap-1.5 rounded-full px-3"
                  >
                    <currentTypeConfig.Icon className="h-3.5 w-3.5 text-muted-foreground" size={14} />
                    <Text className="text-xs text-muted-foreground">{currentTypeConfig.label}</Text>
                    <ChevronDown className="h-3 w-3 text-muted-foreground" size={12} />
                  </Pressable>
                )}
              >
                <PopoverBackdrop />
                <PopoverContent className="w-[280px] p-0">
                  <View className="py-1">
                    {PROJECT_TYPE_OPTIONS.map((opt) => {
                      const isSelected = opt.id === projectType
                      return (
                        <Pressable
                          key={opt.id}
                          onPress={() => {
                            if (onProjectTypeChange) {
                              onProjectTypeChange(opt.id)
                            } else {
                              setInternalProjectType(opt.id)
                            }
                            setTypeMenuOpen(false)
                          }}
                          className={cn(
                            "flex-row items-center gap-3 p-3 rounded-lg mb-1",
                            isSelected && "bg-accent"
                          )}
                        >
                          <View className="w-8 items-center">
                            <opt.Icon className="h-4 w-4 text-muted-foreground" size={16} />
                          </View>
                          <View className="flex-1">
                            <Text className="font-medium text-sm text-foreground">{opt.label}</Text>
                            <Text className="text-xs text-muted-foreground">{opt.description}</Text>
                          </View>
                        </Pressable>
                      )
                    })}
                  </View>
                </PopoverContent>
              </Popover>
            </View>

            <Pressable
              onPress={handleSubmit}
              disabled={(!value.trim() && pendingFiles.length === 0) || disabled || isLoading}
              className={cn(
                "h-8 w-8 rounded-md items-center justify-center",
                (!value.trim() && pendingFiles.length === 0) || disabled || isLoading
                  ? "bg-gray-200 dark:bg-gray-700"
                  : "bg-primary"
              )}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 text-white" size={16} />
              ) : (
                <Send className="h-4 w-4 text-white" size={16} />
              )}
            </Pressable>
          </View>
        </View>
      </View>
    )
  }
)

export default CompactChatInput
