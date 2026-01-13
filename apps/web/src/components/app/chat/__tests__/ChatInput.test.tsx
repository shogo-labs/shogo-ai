/**
 * ChatInput Component Tests
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Tests verify:
 * 1. Renders textarea with submit button
 * 2. Calls onSubmit with content and clears input
 * 3. Disables textarea and button when disabled prop is true
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup, fireEvent, act } from "@testing-library/react"
import { ChatInput } from "../ChatInput"

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
// Test: Renders textarea with submit button (test-2-4-002-008)
// ============================================================
describe("ChatInput renders textarea with submit button", () => {
  test("textarea element is present", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} />)

    const textarea = container.querySelector("textarea")
    expect(textarea).not.toBeNull()
  })

  test("submit button is present", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} />)

    const button = container.querySelector('button[type="submit"]') ||
      container.querySelector('button')
    expect(button).not.toBeNull()
  })

  test("uses shadcn styling", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} />)

    const textarea = container.querySelector("textarea")
    // Should have shadcn textarea styling classes
    expect(textarea?.className).toMatch(/rounded|border|focus/)
  })
})

// ============================================================
// Test: Calls onSubmit with content (test-2-4-002-009)
// ============================================================
describe("ChatInput calls onSubmit with content when submitted", () => {
  test("onSubmit is called with textarea content on button click", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    const button = container.querySelector('button[type="submit"]')!

    // Type content - set value directly for uncontrolled component
    textarea.value = "Hello, world!"

    // Click submit
    await act(async () => {
      fireEvent.click(button)
    })

    expect(mockOnSubmit).toHaveBeenCalledWith("Hello, world!", undefined)
  })

  test("onSubmit is called on Enter key press (without Shift)", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement

    // Type content - set value directly for uncontrolled component
    textarea.value = "Test message"

    // Press Enter
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    })

    expect(mockOnSubmit).toHaveBeenCalledWith("Test message", undefined)
  })

  test("textarea is cleared after submit", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    const button = container.querySelector('button[type="submit"]')!

    // Type content - set value directly for uncontrolled component
    textarea.value = "To be cleared"
    expect(textarea.value).toBe("To be cleared")

    // Submit
    await act(async () => {
      fireEvent.click(button)
    })

    // Should be cleared
    expect(textarea.value).toBe("")
  })
})

// ============================================================
// Test: Disabled state (test-2-4-002-010)
// ============================================================
describe("ChatInput disables textarea and button when disabled prop is true", () => {
  test("textarea has disabled attribute", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} disabled={true} />)

    const textarea = container.querySelector("textarea")
    expect(textarea?.hasAttribute("disabled")).toBe(true)
  })

  test("submit button has disabled attribute", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} disabled={true} />)

    const button = container.querySelector("button")
    expect(button?.hasAttribute("disabled")).toBe(true)
  })

  test("visual styling indicates disabled state", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} disabled={true} />)

    const textarea = container.querySelector("textarea")
    const button = container.querySelector("button")

    // Should have disabled styling (opacity, cursor)
    expect(textarea?.className).toMatch(/disabled|opacity|cursor-not-allowed/)
    expect(button?.className).toMatch(/disabled|opacity|pointer-events-none/)
  })
})

// ============================================================
// Test: Image capture via paste (test-chatinput-paste-detects-image)
// ============================================================
describe("ChatInput image paste handling", () => {
  // Helper to create a mock clipboard event with image data
  const createImagePasteEvent = (base64Data: string = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==") => {
    // Create a small PNG blob
    const binaryString = atob(base64Data)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: "image/png" })
    const file = new File([blob], "test.png", { type: "image/png" })

    // Create mock DataTransfer with files
    const dataTransfer = {
      files: [file],
      items: [{
        kind: "file",
        type: "image/png",
        getAsFile: () => file,
      }],
      types: ["Files"],
    }

    return {
      clipboardData: dataTransfer,
      preventDefault: mock(() => {}),
    }
  }

  test("paste handler detects and extracts image from clipboard", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    const pasteEvent = createImagePasteEvent()

    // Mock FileReader
    const originalFileReader = globalThis.FileReader
    const mockReadAsDataURL = mock(function(this: any, blob: Blob) {
      setTimeout(() => {
        this.result = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        this.onload?.()
      }, 0)
    })
    // @ts-expect-error - mocking FileReader
    globalThis.FileReader = class MockFileReader {
      result: string | null = null
      onload: (() => void) | null = null
      readAsDataURL = mockReadAsDataURL.bind(this)
    }

    await act(async () => {
      fireEvent.paste(textarea, pasteEvent as any)
      // Wait for FileReader to complete
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    // Restore FileReader
    globalThis.FileReader = originalFileReader

    // Should show image preview
    const preview = container.querySelector('[data-testid="image-preview"]')
    expect(preview).not.toBeNull()
  })

  test("paste handler ignores non-image content", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement

    // Create text-only paste event
    const textPasteEvent = {
      clipboardData: {
        files: [],
        items: [{
          kind: "string",
          type: "text/plain",
          getAsFile: () => null,
        }],
        types: ["text/plain"],
      },
      preventDefault: mock(() => {}),
    }

    await act(async () => {
      fireEvent.paste(textarea, textPasteEvent as any)
    })

    // Should NOT show image preview
    const preview = container.querySelector('[data-testid="image-preview"]')
    expect(preview).toBeNull()
  })
})

// ============================================================
// Test: File picker button (test-chatinput-filepicker-opens)
// ============================================================
describe("ChatInput file picker", () => {
  test("file input button is present with image accept attribute", () => {
    const { container } = render(<ChatInput onSubmit={() => {}} />)

    const fileInput = container.querySelector('input[type="file"]')
    expect(fileInput).not.toBeNull()
    expect(fileInput?.getAttribute("accept")).toBe("image/*")
  })

  test("attachment button triggers file input click", async () => {
    const { container } = render(<ChatInput onSubmit={() => {}} />)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const attachButton = container.querySelector('[data-testid="attach-image-button"]')

    expect(attachButton).not.toBeNull()

    // Mock click handler
    const clickMock = mock(() => {})
    fileInput.click = clickMock

    await act(async () => {
      fireEvent.click(attachButton!)
    })

    expect(clickMock).toHaveBeenCalled()
  })
})

// ============================================================
// Test: Image preview and remove (test-chatinput-preview-thumbnail)
// ============================================================
describe("ChatInput image preview", () => {
  test("remove button clears attached image", async () => {
    const mockOnSubmit = mock(() => {})
    const { container, rerender } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement

    // Create a mock paste event with image
    const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const binaryString = atob(base64Data)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: "image/png" })
    const file = new File([blob], "test.png", { type: "image/png" })

    const pasteEvent = {
      clipboardData: {
        files: [file],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        types: ["Files"],
      },
      preventDefault: mock(() => {}),
    }

    // Mock FileReader
    const originalFileReader = globalThis.FileReader
    // @ts-expect-error - mocking FileReader
    globalThis.FileReader = class MockFileReader {
      result: string | null = null
      onload: (() => void) | null = null
      readAsDataURL(_blob: Blob) {
        setTimeout(() => {
          this.result = `data:image/png;base64,${base64Data}`
          this.onload?.()
        }, 0)
      }
    }

    await act(async () => {
      fireEvent.paste(textarea, pasteEvent as any)
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    globalThis.FileReader = originalFileReader

    // Should show preview with remove button
    const removeButton = container.querySelector('[data-testid="remove-image-button"]')
    expect(removeButton).not.toBeNull()

    // Click remove
    await act(async () => {
      fireEvent.click(removeButton!)
    })

    // Preview should be gone
    const preview = container.querySelector('[data-testid="image-preview"]')
    expect(preview).toBeNull()
  })
})

// ============================================================
// Test: Size validation (test-chatinput-validates-size-limit)
// ============================================================
describe("ChatInput image size validation", () => {
  test("rejects images over 4MB with error message", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).not.toBeNull()

    // Create a file > 4MB (5MB)
    const largeArrayBuffer = new ArrayBuffer(5 * 1024 * 1024)
    const file = new File([largeArrayBuffer], "large.png", { type: "image/png" })

    // Create a mock FileList
    const mockFileList = {
      0: file,
      length: 1,
      item: (index: number) => (index === 0 ? file : null),
      [Symbol.iterator]: function* () {
        yield file
      }
    } as unknown as FileList

    // Update the file input's files using fireEvent.change with target.files
    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        value: mockFileList,
        writable: true,
        configurable: true,
      })
      fireEvent.change(fileInput)
    })

    // Should show error message (not preview)
    const errorMessage = container.querySelector('[data-testid="image-error"]')
    expect(errorMessage).not.toBeNull()
    expect(errorMessage?.textContent).toMatch(/4.*MB|size/i)
  })
})

// ============================================================
// Test: onSubmit receives imageData (test-chatinput-submit-with-image)
// ============================================================
describe("ChatInput onSubmit with imageData", () => {
  test("onSubmit is called with text and imageData when image attached", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement

    // Create paste event with image
    const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const binaryString = atob(base64Data)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: "image/png" })
    const file = new File([blob], "test.png", { type: "image/png" })

    const pasteEvent = {
      clipboardData: {
        files: [file],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        types: ["Files"],
      },
      preventDefault: mock(() => {}),
    }

    // Mock FileReader
    const originalFileReader = globalThis.FileReader
    const dataUrl = `data:image/png;base64,${base64Data}`
    // @ts-expect-error - mocking FileReader
    globalThis.FileReader = class MockFileReader {
      result: string | null = null
      onload: (() => void) | null = null
      readAsDataURL(_blob: Blob) {
        setTimeout(() => {
          this.result = dataUrl
          this.onload?.()
        }, 0)
      }
    }

    await act(async () => {
      fireEvent.paste(textarea, pasteEvent as any)
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    globalThis.FileReader = originalFileReader

    // Type text and submit
    textarea.value = "Check this image"
    const submitButton = container.querySelector('button[type="submit"]') || container.querySelector('button')

    await act(async () => {
      fireEvent.click(submitButton!)
    })

    // onSubmit should be called with both text and imageData
    expect(mockOnSubmit).toHaveBeenCalledWith("Check this image", dataUrl)
  })

  test("onSubmit is called with text only when no image attached", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement
    textarea.value = "No image here"

    const submitButton = container.querySelector('button[type="submit"]') || container.querySelector('button')

    await act(async () => {
      fireEvent.click(submitButton!)
    })

    // onSubmit should be called with text only
    expect(mockOnSubmit).toHaveBeenCalledWith("No image here", undefined)
  })

  test("submit clears both text and image state", async () => {
    const mockOnSubmit = mock(() => {})
    const { container } = render(<ChatInput onSubmit={mockOnSubmit} />)

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement

    // Create paste event with image
    const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const binaryString = atob(base64Data)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: "image/png" })
    const file = new File([blob], "test.png", { type: "image/png" })

    const pasteEvent = {
      clipboardData: {
        files: [file],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        types: ["Files"],
      },
      preventDefault: mock(() => {}),
    }

    // Mock FileReader
    const originalFileReader = globalThis.FileReader
    // @ts-expect-error - mocking FileReader
    globalThis.FileReader = class MockFileReader {
      result: string | null = null
      onload: (() => void) | null = null
      readAsDataURL(_blob: Blob) {
        setTimeout(() => {
          this.result = `data:image/png;base64,${base64Data}`
          this.onload?.()
        }, 0)
      }
    }

    await act(async () => {
      fireEvent.paste(textarea, pasteEvent as any)
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    globalThis.FileReader = originalFileReader

    // Type text and submit
    textarea.value = "Message with image"
    const submitButton = container.querySelector('button[type="submit"]') || container.querySelector('button')

    await act(async () => {
      fireEvent.click(submitButton!)
    })

    // Both should be cleared
    expect(textarea.value).toBe("")
    const preview = container.querySelector('[data-testid="image-preview"]')
    expect(preview).toBeNull()
  })
})
