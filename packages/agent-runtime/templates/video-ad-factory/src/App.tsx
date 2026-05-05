// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ThemeProvider, ThemeToggle } from "@/components/ThemeProvider";
import { ProjectList } from "@/components/video/ProjectList";
import { AssetGrid } from "@/components/video/AssetGrid";
import { CharacterGallery } from "@/components/video/CharacterGallery";
import { CreditTracker } from "@/components/video/CreditTracker";
import { Clapperboard } from "lucide-react";
import type { Project, Asset, Character, CreditUsage } from "@/components/video/types";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
// The agent populates these arrays as campaigns are created and assets are
// generated. Leave empty for the initial "no projects" empty state.
// ---------------------------------------------------------------------------

const PROJECTS: Project[] = [];

const ASSETS: Asset[] = [];

const CHARACTERS: Character[] = [];

const CREDITS: CreditUsage | null = null;

export default function App() {
  const [tab, setTab] = useState("projects");

  return (
    <ThemeProvider>
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
        <div className="max-w-6xl mx-auto px-6 py-8 space-y-5">
          <header className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-900 pb-4">
            <div className="flex items-center gap-3">
              <Clapperboard className="h-5 w-5 text-zinc-500 dark:text-zinc-400" />
              <span className="text-sm font-mono uppercase tracking-[0.25em] text-zinc-600 dark:text-zinc-400">
                Video Ad Factory
              </span>
            </div>
            <div className="flex items-center gap-3">
              <CreditTracker credits={CREDITS} />
              <ThemeToggle />
            </div>
          </header>

          <Tabs value={tab} onValueChange={setTab} className="w-full">
            <TabsList className="bg-zinc-100 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
              <TabsTrigger
                value="projects"
                className="text-xs font-mono uppercase tracking-wider"
              >
                Projects
              </TabsTrigger>
              <TabsTrigger
                value="assets"
                className="text-xs font-mono uppercase tracking-wider"
              >
                Assets
              </TabsTrigger>
              <TabsTrigger
                value="characters"
                className="text-xs font-mono uppercase tracking-wider"
              >
                Characters
              </TabsTrigger>
            </TabsList>

            <TabsContent value="projects" className="mt-4">
              <ProjectList projects={PROJECTS} />
            </TabsContent>

            <TabsContent value="assets" className="mt-4">
              <AssetGrid assets={ASSETS} />
            </TabsContent>

            <TabsContent value="characters" className="mt-4">
              <CharacterGallery characters={CHARACTERS} />
            </TabsContent>
          </Tabs>

          <footer className="pt-4 text-[10px] font-mono text-zinc-400 dark:text-zinc-700 uppercase tracking-wider">
            models: seedance 2.0 · sora 2 · veo 3.1 · kling 3.0 · nano banana
          </footer>
        </div>
      </div>
    </ThemeProvider>
  );
}
