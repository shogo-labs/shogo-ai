/**
 * HomePage - Main dashboard/home page component
 * 
 * Displays when no project is selected. Features:
 * - Personalized greeting with user's name
 * - Beautiful gradient mesh background
 * - AI prompt input for creating new projects/features
 * - Templates carousel (placeholder for now)
 * 
 * Inspired by Lovable.dev's engaging home page design.
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { useNavigate } from "react-router-dom"
import { Paperclip, Palette, MessageSquare, Send, Sparkles, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

interface HomePageProps {
  /** User's display name for personalized greeting */
  userName?: string
  /** Callback when a new prompt is submitted */
  onPromptSubmit?: (prompt: string) => void
  /** Loading state - true when creating project/feature from prompt */
  isLoading?: boolean
}

/**
 * HomePage component
 * 
 * Main landing page for the app dashboard when no project is selected.
 * Features a personalized greeting and AI-powered prompt interface.
 */
export const HomePage = observer(function HomePage({
  userName = "there",
  onPromptSubmit,
  isLoading = false,
}: HomePageProps) {
  const [prompt, setPrompt] = useState("")
  const navigate = useNavigate()

  const handleSubmit = () => {
    if (prompt.trim() && onPromptSubmit && !isLoading) {
      onPromptSubmit(prompt)
      // Don't clear prompt immediately - let the navigation happen first
      // The component will unmount when navigating to the project
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // Get first name only for greeting
  const firstName = userName.split(" ")[0] || "there"

  return (
    <div className="relative h-full flex flex-col">
      {/* Gradient mesh background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute top-1/4 left-1/4 w-[600px] h-[600px] rounded-full opacity-30 blur-3xl"
          style={{
            background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 50%, #ec4899 100%)",
          }}
        />
        <div
          className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] rounded-full opacity-25 blur-3xl"
          style={{
            background: "linear-gradient(135deg, #f97316 0%, #ec4899 50%, #8b5cf6 100%)",
          }}
        />
      </div>

      {/* Main content */}
      <div className="relative flex-1 flex flex-col items-center justify-center p-8">
        {/* Greeting */}
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-center mb-8 bg-clip-text text-transparent bg-gradient-to-r from-foreground via-foreground to-foreground/80">
          What's on your mind, {firstName}?
        </h1>

        {/* AI Prompt Input Card */}
        <div className="w-full max-w-2xl">
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-xl shadow-lg overflow-hidden">
            {/* Input area */}
            <div className="p-4">
              <Textarea
                placeholder="Ask Shogo to create a web app that..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isLoading}
                className="min-h-[80px] resize-none border-0 bg-transparent p-0 text-base focus-visible:ring-0 placeholder:text-muted-foreground/60"
                rows={3}
              />
            </div>

            {/* Action bar */}
            <div className="px-4 pb-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
                >
                  <Paperclip className="h-4 w-4" />
                  <span className="hidden sm:inline text-xs">Attach</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
                >
                  <Palette className="h-4 w-4" />
                  <span className="hidden sm:inline text-xs">Theme</span>
                </Button>
              </div>
              
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5"
                >
                  <MessageSquare className="h-4 w-4" />
                  <span className="text-xs">Chat</span>
                </Button>
                <Button
                  size="sm"
                  className="h-8 px-3"
                  onClick={handleSubmit}
                  disabled={!prompt.trim() || isLoading}
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Quick suggestions */}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {[
            "Build a landing page",
            "Create a dashboard",
            "Design a form",
            "Make an API integration",
          ].map((suggestion) => (
            <Button
              key={suggestion}
              variant="outline"
              size="sm"
              className="h-8 text-xs bg-card/50 backdrop-blur-sm hover:bg-card"
              onClick={() => setPrompt(suggestion)}
            >
              <Sparkles className="h-3 w-3 mr-1.5 text-purple-400" />
              {suggestion}
            </Button>
          ))}
        </div>
      </div>

      {/* Templates section */}
      <div className="relative bg-card/50 backdrop-blur-sm border-t border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium">Templates</h2>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => navigate("/templates")}
          >
            Browse all →
          </Button>
        </div>
        
        {/* Template cards placeholder */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {[
            { name: "Portfolio", desc: "Personal website" },
            { name: "E-commerce", desc: "Online store" },
            { name: "Dashboard", desc: "Admin panel" },
            { name: "Blog", desc: "Content site" },
            { name: "Landing", desc: "Marketing page" },
            { name: "SaaS", desc: "Web application" },
          ].map((template) => (
            <div
              key={template.name}
              className="group p-3 bg-card rounded-lg border border-border hover:border-primary/50 transition-colors cursor-pointer"
            >
              <div className="aspect-video bg-muted rounded mb-2" />
              <div className="text-xs font-medium truncate">{template.name}</div>
              <div className="text-[10px] text-muted-foreground truncate">
                {template.desc}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
})
