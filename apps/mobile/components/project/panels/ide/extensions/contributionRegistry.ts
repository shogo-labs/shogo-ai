import type { InstalledExtension } from "./types";

export interface ExtensionCommandContribution {
  extensionId: string;
  command: string;
  title: string;
  category?: string;
}

export function collectExtensionCommands(extensions: InstalledExtension[]): ExtensionCommandContribution[] {
  return extensions.flatMap((extension) =>
    (extension.manifest.contributes?.commands ?? []).map((command) => ({
      extensionId: extension.id,
      command: command.command,
      title: command.title,
      category: command.category,
    })),
  );
}
