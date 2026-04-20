// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Workbench } from "./components/ide/Workbench";
import { agentFs } from "./components/ide/workspace/agentFs";

export default function App() {
  return <Workbench agentService={agentFs} />;
}
