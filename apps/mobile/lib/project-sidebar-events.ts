// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

type OpenProjectSidebarListener = (projectId: string) => void

const openProjectSidebarListeners = new Set<OpenProjectSidebarListener>()

/** Bridges the project chat header and the shared app drawer. */
export const projectSidebarEvents = {
  subscribeOpenProject(listener: OpenProjectSidebarListener) {
    openProjectSidebarListeners.add(listener)
    return () => openProjectSidebarListeners.delete(listener)
  },

  requestOpenProject(projectId: string) {
    if (!projectId) return
    openProjectSidebarListeners.forEach((listener) => listener(projectId))
  },
}
