export interface Command {
  id: string;
  label: string;
  category?: string;
  shortcut?: string;
  run: () => void | Promise<void>;
}

export function matchesShortcut(
  e: KeyboardEvent,
  combo: { meta?: boolean; shift?: boolean; alt?: boolean; key: string },
): boolean {
  const meta = e.metaKey || e.ctrlKey;
  if ((combo.meta ?? false) !== meta) return false;
  if ((combo.shift ?? false) !== e.shiftKey) return false;
  if ((combo.alt ?? false) !== e.altKey) return false;
  return e.key.toLowerCase() === combo.key.toLowerCase();
}
