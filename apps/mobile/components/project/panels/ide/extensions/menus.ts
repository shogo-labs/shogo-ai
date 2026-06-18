import { evaluateWhenClause, type WhenContext } from "./whenClause";

export interface ExtensionMenuItem {
  command: string;
  when?: string;
  group?: string;
  alt?: string;
}

export function visibleMenuItems(items: ExtensionMenuItem[] | undefined, context: WhenContext): ExtensionMenuItem[] {
  return (items ?? []).filter((item) => evaluateWhenClause(item.when, context));
}
