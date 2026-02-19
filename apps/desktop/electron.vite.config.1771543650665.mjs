// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "path";
var __electron_vite_injected_dirname = "/Users/rithwik/rithwik/odin/shogo-ai/apps/desktop";
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/main/index.ts")
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts")
        }
      }
    }
  },
  renderer: {}
});
export {
  electron_vite_config_default as default
};
