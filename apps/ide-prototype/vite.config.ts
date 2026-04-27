// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsConfigPaths from "vite-tsconfig-paths";

const IDE_SERVER_PORT = process.env.IDE_SERVER_PORT ?? "38325";

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    host: "0.0.0.0",
    cors: true,
    proxy: {
      "/api": { target: `http://localhost:${IDE_SERVER_PORT}`, changeOrigin: true },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  plugins: [tsConfigPaths({ projects: ["./tsconfig.json"] }), react()],
  build: { target: "esnext", minify: false },
});
