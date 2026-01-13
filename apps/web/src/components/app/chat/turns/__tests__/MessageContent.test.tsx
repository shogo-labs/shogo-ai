/**
 * MessageContent Component Tests
 * Task: task-render-image-history
 *
 * Tests verify:
 * 1. Text-only messages render as before (backward compatible)
 * 2. Image parts are detected and rendered as img elements
 * 3. Images have appropriate sizing and styling
 * 4. Click on image opens larger view
 * 5. User and assistant messages with images render correctly
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup, fireEvent } from "@testing-library/react"
import { MessageContent } from "../MessageContent"

// Set up happy-dom
import { Window } from "happy-dom"

let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window type mismatch
  globalThis.window = window
  // @ts-expect-error - happy-dom Document type mismatch
  globalThis.document = window.document
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

afterEach(() => {
  cleanup()
})

// ============================================================
// Test: Text-only messages render as before (backward compatible)
// ============================================================
describe("MessageContent backward compatibility", () => {
  test("text-only message renders text content", () => {
    const message = {
      id: "msg-1",
      role: "user" as const,
      content: "Hello, world!",
      parts: [{ type: "text", text: "Hello, world!" }],
    }

    const { container } = render(<MessageContent message={message} />)

    expect(container.textContent).toContain("Hello, world!")
  })

  test("message without parts uses content string", () => {
    const message = {
      id: "msg-2",
      role: "assistant" as const,
      content: "How can I help you?",
    }

    const { container } = render(<MessageContent message={message} />)

    expect(container.textContent).toContain("How can I help you?")
  })

  test("no image elements present for text-only messages", () => {
    const message = {
      id: "msg-3",
      role: "user" as const,
      content: "Just text",
      parts: [{ type: "text", text: "Just text" }],
    }

    const { container } = render(<MessageContent message={message} />)

    const images = container.querySelectorAll("img")
    expect(images.length).toBe(0)
  })
})

// ============================================================
// Test: Image parts are detected and rendered
// ============================================================
describe("MessageContent image rendering", () => {
  test("file part with image mediaType renders as img element", () => {
    const message = {
      id: "msg-4",
      role: "user" as const,
      content: "",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    }

    const { container } = render(<MessageContent message={message} />)

    const img = container.querySelector("img")
    expect(img).not.toBeNull()
    expect(img?.src).toContain("data:image/png")
  })

  test("image has alt text describing attachment", () => {
    const message = {
      id: "msg-5",
      role: "user" as const,
      content: "",
      parts: [
        {
          type: "file",
          mediaType: "image/jpeg",
          url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==",
        },
      ],
    }

    const { container } = render(<MessageContent message={message} />)

    const img = container.querySelector("img")
    expect(img?.alt).toBeDefined()
    expect(img?.alt).not.toBe("")
  })

  test("multiple images in message all render", () => {
    const message = {
      id: "msg-6",
      role: "user" as const,
      content: "",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,image1data",
        },
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,image2data",
        },
      ],
    }

    const { container } = render(<MessageContent message={message} />)

    const images = container.querySelectorAll("img")
    expect(images.length).toBe(2)
  })
})

// ============================================================
// Test: Image sizing and styling
// ============================================================
describe("MessageContent image styling", () => {
  test("image has max-width constraint for thumbnail", () => {
    const message = {
      id: "msg-7",
      role: "user" as const,
      content: "",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,iVBORw0KGgo==",
        },
      ],
    }

    const { container } = render(<MessageContent message={message} />)

    const img = container.querySelector("img")
    // Check for max-width class (e.g., max-w-[300px] or similar)
    expect(img?.className).toMatch(/max-w|max-width/)
  })
})

// ============================================================
// Test: Mixed text and image content
// ============================================================
describe("MessageContent mixed content", () => {
  test("text and image parts render together", () => {
    const message = {
      id: "msg-8",
      role: "user" as const,
      content: "",
      parts: [
        { type: "text", text: "Check out this image:" },
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,iVBORw0KGgo==",
        },
      ],
    }

    const { container } = render(<MessageContent message={message} />)

    // Should have both text and image
    expect(container.textContent).toContain("Check out this image:")
    const img = container.querySelector("img")
    expect(img).not.toBeNull()
  })
})

// ============================================================
// Test: User and assistant messages render correctly
// ============================================================
describe("MessageContent role-based rendering", () => {
  test("user message with image has user styling", () => {
    const message = {
      id: "msg-9",
      role: "user" as const,
      content: "",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,iVBORw0KGgo==",
        },
      ],
    }

    const { container } = render(<MessageContent message={message} />)

    // User messages typically have specific styling (e.g., ml-auto for right alignment)
    const wrapper = container.querySelector("div")
    expect(wrapper?.className).toMatch(/primary|ml-auto/)
  })

  test("assistant message with image has assistant styling", () => {
    const message = {
      id: "msg-10",
      role: "assistant" as const,
      content: "",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,iVBORw0KGgo==",
        },
      ],
    }

    const { container } = render(<MessageContent message={message} />)

    // Assistant messages typically have different styling
    const wrapper = container.querySelector("div")
    expect(wrapper?.className).toMatch(/muted|mr-auto/)
  })
})

// ============================================================
// Test: Image click behavior
// ============================================================
describe("MessageContent image interaction", () => {
  test("image is clickable (has cursor-pointer or onClick)", () => {
    const message = {
      id: "msg-11",
      role: "user" as const,
      content: "",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,iVBORw0KGgo==",
        },
      ],
    }

    const { container } = render(<MessageContent message={message} />)

    const img = container.querySelector("img")
    // Should have cursor-pointer class or be wrapped in clickable element
    const clickableElement = img?.closest("[data-testid='image-thumbnail']") || img?.closest("button") || img?.closest("a")
    const hasClickableClass = img?.className.includes("cursor-pointer")
    expect(clickableElement !== null || hasClickableClass).toBe(true)
  })
})

// ============================================================
// Test: Fallback for broken images
// ============================================================
describe("MessageContent image fallback", () => {
  test("component handles missing url gracefully", () => {
    const message = {
      id: "msg-12",
      role: "user" as const,
      content: "",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          // Missing url
        },
      ],
    }

    // Should not crash
    const { container } = render(<MessageContent message={message} />)
    expect(container).toBeDefined()
  })
})
