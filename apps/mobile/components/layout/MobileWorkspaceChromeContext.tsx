// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createContext, useContext, type ReactNode } from "react";

const MobileWorkspaceChromeContext = createContext(false);

export function MobileWorkspaceChromeProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <MobileWorkspaceChromeContext.Provider value>
      {children}
    </MobileWorkspaceChromeContext.Provider>
  );
}

export function useMobileWorkspaceChrome() {
  return useContext(MobileWorkspaceChromeContext);
}
