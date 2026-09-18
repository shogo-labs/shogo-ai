// Figma Notes reference: 402 x 874 mobile frame.
// The base dark surface is verified from the supplied design and matches the
// existing application background token. Keep these aliases centralized so
// visual QA can replace a value without changing screen components.
export const NOTES_DESIGN_TOKENS = {
  background: "#141313",
  card: "#2a2a29",
  elevated: "#353434",
  border: "#3c3c3c",
  primary: "#fb8c00",
  onPrimary: "#1c1b1b",
  text: "#ffffff",
  secondaryText: "#c4c7c5",
  placeholder: "#c4c7c5",
  success: "#58d6ae",
  destructive: "#ff7777",
  radius: 8,
  rowHeight: 56,
  horizontalPadding: 24,
  sectionGap: 20,
  iconSize: 24,
} as const;
