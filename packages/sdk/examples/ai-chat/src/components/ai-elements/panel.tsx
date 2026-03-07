// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Panel as PanelPrimitive } from "@xyflow/react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type PanelProps = ComponentProps<typeof PanelPrimitive>;

export const Panel = ({ className, ...props }: PanelProps) => (
  <PanelPrimitive
    className={cn(
      "m-4 overflow-hidden rounded-md border bg-card p-1",
      className
    )}
    {...props}
  />
);
