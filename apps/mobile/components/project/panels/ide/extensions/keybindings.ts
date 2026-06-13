export interface ExtensionKeybinding {
  command?: string;
  key?: string;
  mac?: string;
  win?: string;
  linux?: string;
  when?: string;
}

export function normalizeKeybinding(binding: ExtensionKeybinding, platform: "mac" | "win" | "linux"): string | null {
  return binding[platform] ?? binding.key ?? null;
}
