/**
 * ManageBillingDialog Component
 *
 * Dialog for managing billing account information, matching Lovable.dev's pattern.
 * Provides options to edit billing information and view invoices/payments via Stripe portal.
 */

import { useState } from "react"
import { CreditCard, FileText, Loader2 } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

export interface ManageBillingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  currentPlanName?: string
}

export function ManageBillingDialog({
  open,
  onOpenChange,
  workspaceId,
  currentPlanName = "Free Plan",
}: ManageBillingDialogProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [loadingAction, setLoadingAction] = useState<"billing" | "invoices" | null>(null)

  const handleOpenPortal = async (action: "billing" | "invoices") => {
    setIsLoading(true)
    setLoadingAction(action)

    try {
      // Create portal session with return URL
      const returnUrl = `${window.location.origin}/app/billing`
      const response = await fetch(`/api/billing/portal?workspaceId=${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ returnUrl }),
      })

      const data = await response.json()

      if (data.error) {
        console.error('Failed to open portal:', data.error)
        alert('Failed to open billing portal. Please try again.')
        return
      }

      if (data.url) {
        // Redirect to Stripe portal
        window.location.href = data.url
      }
    } catch (err) {
      console.error('Failed to open portal:', err)
      alert('Failed to open billing portal. Please try again.')
    } finally {
      setIsLoading(false)
      setLoadingAction(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage plan</DialogTitle>
          <DialogDescription>Subscription & billing settings</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Current Plan Display */}
          <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="text-lg font-semibold text-primary">S</span>
            </div>
            <div className="flex-1">
              <div className="font-medium">You're on {currentPlanName}</div>
              <div className="text-sm text-muted-foreground">Upgrade anytime</div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="space-y-2">
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => handleOpenPortal("billing")}
              disabled={isLoading}
            >
              {isLoading && loadingAction === "billing" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CreditCard className="h-4 w-4 mr-2" />
              )}
              Edit billing information
            </Button>

            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => handleOpenPortal("invoices")}
              disabled={isLoading}
            >
              {isLoading && loadingAction === "invoices" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FileText className="h-4 w-4 mr-2" />
              )}
              Invoices & payments
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
