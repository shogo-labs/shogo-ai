/**
 * Generated from TestSpecifications for task-2-1-001
 * Tests: shadcn component installation verification
 */

import { describe, test, expect } from "bun:test"

describe("shadcn components installation", () => {
  test("tabs component is installed and importable", async () => {
    const tabs = await import("@/components/ui/tabs")
    expect(tabs.Tabs).toBeDefined()
    expect(tabs.TabsList).toBeDefined()
    expect(tabs.TabsTrigger).toBeDefined()
    expect(tabs.TabsContent).toBeDefined()
  })

  test("alert component is installed and importable", async () => {
    const alert = await import("@/components/ui/alert")
    expect(alert.Alert).toBeDefined()
    expect(alert.AlertTitle).toBeDefined()
    expect(alert.AlertDescription).toBeDefined()
  })

  test("dropdown-menu component is installed and importable", async () => {
    const dropdownMenu = await import("@/components/ui/dropdown-menu")
    expect(dropdownMenu.DropdownMenu).toBeDefined()
    expect(dropdownMenu.DropdownMenuTrigger).toBeDefined()
    expect(dropdownMenu.DropdownMenuContent).toBeDefined()
    expect(dropdownMenu.DropdownMenuItem).toBeDefined()
  })

  test("avatar component is installed and importable", async () => {
    const avatar = await import("@/components/ui/avatar")
    expect(avatar.Avatar).toBeDefined()
    expect(avatar.AvatarImage).toBeDefined()
    expect(avatar.AvatarFallback).toBeDefined()
  })
})
