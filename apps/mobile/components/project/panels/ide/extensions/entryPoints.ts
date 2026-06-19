import type { ExtensionUsableEntryPoint } from "./types";

export function getEntryPointActionLabel(entryPoint: ExtensionUsableEntryPoint): string {
  switch (entryPoint.kind) {
    case "command":
      return `Run ${entryPoint.label}`;
    case "view":
    case "viewContainer":
      return `Open ${entryPoint.label}`;
    case "startupActivation":
      return "Activate extension";
  }
}

export function getEntryPointKindLabel(entryPoint: ExtensionUsableEntryPoint): string {
  switch (entryPoint.kind) {
    case "command":
      return "Command";
    case "view":
      return "View";
    case "viewContainer":
      return entryPoint.detail === "Panel" ? "Panel" : "Activity Bar";
    case "startupActivation":
      return "Activation";
  }
}
