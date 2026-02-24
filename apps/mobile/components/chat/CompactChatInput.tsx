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

import { useState, useRef, useCallback, forwardRef } from "react"
import { View, Text, TextInput, Pressable, Image, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Paperclip, Send, Loader2, X, File, FileText, ImageIcon } from "lucide-react-native"

export type ProjectType = "APP" | "AGENT"

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
  onSubmit: (prompt: string, imageData?: string[]) => void
  disabled?: boolean
  isLoading?: boolean
  placeholder?: string
  className?: string
  value?: string
  onChange?: (value: string) => void
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
    },
    ref
  ) {
    const [internalValue, setInternalValue] = useState("")
    const textInputRef = useRef<TextInput>(null)

    const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
    const [fileError, setFileError] = useState<string | null>(null)

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

      const fileData =
        pendingFiles.length > 0 ? pendingFiles.map((f) => f.dataUrl) : undefined

      onSubmit(trimmedContent, fileData)
    }, [value, disabled, isLoading, onSubmit, pendingFiles])

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
        <View className="bg-white/80 dark:bg-gray-900/80 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
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
              editable={!disabled && !isLoading}
              multiline
              className="min-h-[80px] text-base text-foreground"
              textAlignVertical="top"
            />
          </View>

          {/* Action bar */}
          <View className="px-4 pb-4 flex-row items-center justify-between gap-2">
            <View className="flex-row items-center gap-1">
              <Pressable
                className="h-8 flex-row items-center gap-1.5 px-2"
                disabled={disabled || isLoading || pendingFiles.length >= MAX_FILES}
              >
                <Paperclip className="h-4 w-4 text-gray-400" size={16} />
                <Text className="text-xs text-gray-400">Attach</Text>
              </Pressable>
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
