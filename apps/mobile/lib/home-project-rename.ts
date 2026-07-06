// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

type ChatScope = 'project' | 'workspace'

type ProjectRenameActions = {
  updateProject: (
    projectId: string,
    changes: { name?: string; description?: string | undefined },
  ) => Promise<unknown>
  updateChatSession: (
    chatSessionId: string,
    changes: { inferredName?: string },
  ) => Promise<unknown>
}

type GenerateProjectName = (
  text: string,
) => Promise<{ name?: string | null; description?: string | null }>

type StartProjectNameRefinementOptions = {
  actions: ProjectRenameActions
  projectId: string
  chatSessionId: string
  chatScope: ChatScope
  text: string
  heuristicName: string
  generateProjectName: GenerateProjectName
  onError?: (message: string, error: unknown) => void
}

export function startProjectNameRefinement({
  actions,
  projectId,
  chatSessionId,
  chatScope,
  text,
  heuristicName,
  generateProjectName,
  onError,
}: StartProjectNameRefinementOptions) {
  const heuristicRename = actions
    .updateProject(projectId, { name: heuristicName })
    .catch((error) => {
      onError?.('[Home] Heuristic project rename failed:', error)
    })

  const generatedRename = generateProjectName(text)
    .then(async ({ name, description }) => {
      if (!name || name === heuristicName) return

      await heuristicRename
      await actions.updateProject(projectId, {
        name,
        description: description || undefined,
      })

      if (chatScope === 'project') {
        await actions.updateChatSession(chatSessionId, { inferredName: name })
      }
    })
    .catch((error) => {
      onError?.('[Home] AI project name refinement failed, keeping heuristic name:', error)
    })

  return { heuristicRename, generatedRename }
}
