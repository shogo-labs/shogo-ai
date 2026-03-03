import React, { memo, useRef, useEffect, useCallback } from "react"
import { Streamdown } from "streamdown"
import { code } from "@streamdown/code"
import "streamdown/styles.css"

export interface MarkdownTextProps {
  children: string
  className?: string
  isStreaming?: boolean
}

const linkSafetyOff = { enabled: false as const }
const plugins = { code }

export const MarkdownText = memo(
  function MarkdownText({ children, className, isStreaming }: MarkdownTextProps) {
    const containerRef = useRef<HTMLDivElement>(null)

    const handleClick = useCallback((e: MouseEvent) => {
      const container = containerRef.current
      if (!container) return

      const { clientX: x, clientY: y } = e

      // Check copy buttons by bounding rect since CSS stacking prevents normal hit-testing
      const copyBtns = container.querySelectorAll<HTMLElement>(
        '[data-streamdown="code-block-copy-button"]'
      )
      for (const btn of copyBtns) {
        const r = btn.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          e.preventDefault()
          e.stopPropagation()

          const codeBlock = btn.closest('[data-streamdown="code-block"]')
          const pre = codeBlock?.querySelector("pre")
          const text = pre?.textContent ?? ""
          if (!text) return

          navigator.clipboard.writeText(text).then(() => {
            btn.dataset.copied = "true"

            const rect = btn.getBoundingClientRect()
            const tip = document.createElement("span")
            tip.textContent = "Copied!"
            tip.className = "sdw-copy-toast"
            tip.style.top = `${rect.top + rect.height / 2}px`
            tip.style.left = `${rect.left - 6}px`
            document.body.appendChild(tip)

            setTimeout(() => {
              delete btn.dataset.copied
              tip.remove()
            }, 1500)
          }).catch(() => {})
          return
        }
      }

      // Also check download buttons
      const dlBtns = container.querySelectorAll<HTMLElement>(
        '[data-streamdown="code-block-download-button"]'
      )
      for (const btn of dlBtns) {
        const r = btn.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          btn.click()
          return
        }
      }
    }, [])

    useEffect(() => {
      const el = containerRef.current
      if (!el) return
      el.addEventListener("click", handleClick, true)
      return () => el.removeEventListener("click", handleClick, true)
    }, [handleClick])

    return (
      <div ref={containerRef}>
        <Streamdown
          className={className}
          isAnimating={isStreaming}
          linkSafety={linkSafetyOff}
          plugins={plugins}
        >
          {children || ""}
        </Streamdown>
      </div>
    )
  },
  (prev, next) =>
    prev.children === next.children && prev.isStreaming === next.isStreaming
)
