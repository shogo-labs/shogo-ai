/**
 * MCP Tool: image.save
 *
 * Save a staged user-attached image to the project's public/ directory
 * with a meaningful filename so it can be referenced in code.
 *
 * Images are staged to .image-staging/ by the project runtime when
 * users attach them in chat. This tool moves them to public/ where
 * Vite serves them at the root path.
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { join } from "path"
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "fs"

const PROJECT_DIR = process.env.PROJECT_DIR || "/app/project"

const Params = t({
  imageId: "string",
  "filename?": "string",
})

export function registerImageSave(server: FastMCP) {
  server.addTool({
    name: "image.save",
    description: `Save a user-attached image to the project's public/ directory so it can be referenced in code.

When users attach images in chat, they are staged to .image-staging/ with IDs like "image-0", "image-1".
Call this tool to save a specific image to public/ with a meaningful filename.

The image will be served at /<filename> by Vite.
- In CSS: url('/<filename>')
- In JSX: <img src="/<filename>" />

Parameters:
- imageId: The image identifier (e.g. "image-0") from the staged images list
- filename: Desired filename (e.g. "hero-bg.png", "logo.svg"). If omitted, defaults to the imageId with its original extension.`,
    parameters: Params as any,
    execute: async (args: any) => {
      const { imageId, filename } = args as { imageId: string; filename?: string }

      const stagingDir = join(PROJECT_DIR, ".image-staging")

      // Find the staged image file matching the imageId
      if (!existsSync(stagingDir)) {
        return JSON.stringify({
          ok: false,
          error: "No staged images found. The user has not attached any images in this conversation.",
        })
      }

      const stagedFiles = readdirSync(stagingDir)
      const matchingFile = stagedFiles.find((f) => f.startsWith(imageId))
      if (!matchingFile) {
        const available = stagedFiles
          .filter((f) => f.startsWith("image-"))
          .map((f) => f.replace(/\.\w+$/, ""))
        return JSON.stringify({
          ok: false,
          error: `Image "${imageId}" not found in staging. Available images: ${available.length > 0 ? available.join(", ") : "none"}`,
        })
      }

      // Determine the final filename
      const originalExt = matchingFile.substring(matchingFile.lastIndexOf("."))
      let finalFilename: string
      if (filename) {
        const hasExt = /\.\w+$/.test(filename)
        finalFilename = hasExt ? filename : `${filename}${originalExt}`
      } else {
        finalFilename = matchingFile // e.g. "image-0.png"
      }

      // Sanitize: remove path traversal, only allow safe filename characters
      finalFilename = finalFilename.replace(/[^a-zA-Z0-9._-]/g, "-")

      const publicDir = join(PROJECT_DIR, "public")
      if (!existsSync(publicDir)) {
        mkdirSync(publicDir, { recursive: true })
      }

      const sourcePath = join(stagingDir, matchingFile)
      const destPath = join(publicDir, finalFilename)

      try {
        copyFileSync(sourcePath, destPath)
        console.log(`[image.save] Saved ${imageId} -> public/${finalFilename}`)
        return JSON.stringify({
          ok: true,
          path: `public/${finalFilename}`,
          servePath: `/${finalFilename}`,
          message: `Image saved to public/${finalFilename}. Use "/${finalFilename}" in src attributes or url() in CSS.`,
        })
      } catch (err: any) {
        console.error(`[image.save] Failed to save ${imageId}:`, err)
        return JSON.stringify({
          ok: false,
          error: `Failed to save image: ${err.message}`,
        })
      }
    },
  })
}
