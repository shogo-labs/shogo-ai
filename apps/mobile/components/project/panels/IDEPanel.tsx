// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo } from 'react'
import { Platform, View, Text } from 'react-native'
import { Code2 } from 'lucide-react-native'
import { Workbench } from './ide/Workbench'
import { sdkFsFor } from './ide/workspace/sdkFs'

interface IDEPanelProps {
  visible: boolean
  projectId: string
  agentUrl?: string | null
}

/**
 * Web-only IDE tab. The Workbench is built on Monaco + plain DOM so it only
 * works on react-native-web — on native iOS/Android we render a placeholder
 * that points users at a desktop browser.
 *
 * File ops (list, read, write, rename, delete, mkdir, search) flow through
 * AgentClient against the project's per-project agentUrl. Terminal and git
 * are rendered as "backend-pending" placeholders until the agent-runtime
 * exposes those routes (follow-up phase).
 */
export function IDEPanel({ visible, projectId, agentUrl }: IDEPanelProps) {
  const agentService = useMemo(
    () => (agentUrl ? sdkFsFor(agentUrl, `project/${projectId}`) : null),
    [agentUrl, projectId],
  )

  if (!visible) return null

  if (Platform.OS !== 'web') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#1e1e1e' }}>
        <Code2 size={32} color="#0078d4" />
        <Text style={{ color: '#cccccc', fontSize: 14, fontWeight: '600', marginTop: 12 }}>
          IDE requires a desktop browser
        </Text>
        <Text style={{ color: '#858585', fontSize: 12, marginTop: 6, textAlign: 'center', maxWidth: 320 }}>
          The full code editor is built on Monaco (DOM-only). Open this project
          in Chrome or Edge on your desktop to use the IDE tab.
        </Text>
      </View>
    )
  }

  if (!agentService) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#1e1e1e' }}>
        <Text style={{ color: '#858585', fontSize: 12 }}>Agent not ready yet…</Text>
      </View>
    )
  }

  // On web, react-native-web renders <View> as a div. Nest a raw HTML
  // container so Monaco and xterm have a real DOM subtree to mount into.
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <Workbench agentService={agentService} agentLabel={`project/${projectId}`} />
      </div>
    </View>
  )
}
