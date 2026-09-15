import { GENERATED_FILE_LICENSE_HEADER } from './generated-file-license-header'

export interface ChatComponentsGeneratorOptions {
  fileExtension?: 'tsx' | 'ts'
  sdkReactImport?: string
}

export interface GeneratedChatComponentFile {
  fileName: string
  code: string
  skipIfExists: true
}

export function generateChatComponents(
  options: ChatComponentsGeneratorOptions = {},
): GeneratedChatComponentFile[] {
  const extension = options.fileExtension === 'ts' ? 'ts' : 'tsx'
  const sdkImport = options.sdkReactImport || '@shogo-ai/chat/react'
  const header = GENERATED_FILE_LICENSE_HEADER.trim()
  return [
    {
      fileName: `ChatLauncher.${extension}`,
      skipIfExists: true,
      code: `${header}
import { ChatLauncher } from '${sdkImport}'
import { createChatClient } from '@shogo-ai/chat'

const client = createChatClient({
  apiUrl: import.meta.env.VITE_SHOGO_API_URL || window.location.origin,
  projectId: import.meta.env.VITE_SHOGO_PROJECT_ID || '',
  publishableKey: import.meta.env.VITE_SHOGO_PUBLISHABLE_KEY,
  // Generated pod apps use the same-origin persona route by default.
  transport: 'persona',
})

export default function ChatLauncherComponent() {
  return <ChatLauncher client={client} title="Chat with us" />
}
`,
    },
    {
      fileName: `ChatPage.${extension}`,
      skipIfExists: true,
      code: `${header}
import { ChatPage } from '${sdkImport}'
import { createChatClient } from '@shogo-ai/chat'

const client = createChatClient({
  apiUrl: import.meta.env.VITE_SHOGO_API_URL || window.location.origin,
  projectId: import.meta.env.VITE_SHOGO_PROJECT_ID || '',
  publishableKey: import.meta.env.VITE_SHOGO_PUBLISHABLE_KEY,
  // Generated pod apps use the same-origin persona route by default.
  transport: 'persona',
})

export default function ChatPageComponent() {
  return <ChatPage client={client} />
}
`,
    },
    {
      fileName: `index.${extension}`,
      skipIfExists: true,
      code: `${header}
export { default as ChatLauncher } from './ChatLauncher'
export { default as ChatPage } from './ChatPage'
`,
    },
  ]
}
