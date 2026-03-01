import { useState, useCallback } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
} from 'react-native'
import {
  Share2,
  Copy,
  Check,
  Link,
  Mail,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import * as Clipboard from 'expo-clipboard'

interface ShareProjectDropdownProps {
  projectId: string
  projectName: string
  workspaceId: string
}

export function ShareProjectDropdown({
  projectId,
  projectName,
  workspaceId,
}: ShareProjectDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const shareUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/projects/${projectId}`

  const handleCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard not available
    }
  }, [shareUrl])

  return (
    <Popover
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      onOpen={() => setIsOpen(true)}
      placement="bottom right"
      trigger={(triggerProps: any) => (
        <Pressable
          {...triggerProps}
          className="h-8 w-8 items-center justify-center rounded-md active:bg-muted"
        >
          <Share2 size={16} className="text-muted-foreground" />
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="w-80 p-0">
        <PopoverBody>
          <View className="p-4 gap-3">
            <Text className="text-sm font-semibold text-foreground">
              Share &ldquo;{projectName}&rdquo;
            </Text>

            <View className="flex-row items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2">
              <Link size={14} className="text-muted-foreground flex-shrink-0" />
              <Text
                className="text-xs text-muted-foreground flex-1"
                numberOfLines={1}
              >
                {shareUrl}
              </Text>
              <Pressable onPress={handleCopy} className="flex-shrink-0">
                {copied ? (
                  <Check size={14} className="text-green-500" />
                ) : (
                  <Copy size={14} className="text-muted-foreground" />
                )}
              </Pressable>
            </View>
          </View>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}
