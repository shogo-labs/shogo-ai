// SPDX-License-Identifier: MIT
// Visual design adapted from @vscode/codicons (MIT / CC BY 4.0,
// © Microsoft VS Code team). We do NOT ship the verbatim codicon paths
// because their evenodd-fillRule geometry does not render reliably in
// react-native-svg — instead we re-draw the same icons with explicit
// <Circle> and <Path> primitives so the output is pixel-deterministic
// across web (Expo web export inside Electron), iOS, and Android.

import Svg, { Circle, Path } from "react-native-svg";

interface IconProps {
  size?: number;
  color?: string;
}

/**
 * VS Code "source-control" codicon — three filled circles connected by a
 * Y-branch. Two endpoints stacked on the left (top + bottom), one
 * endpoint protruding to the right at the midpoint of the trunk.
 *
 * Reference: https://microsoft.github.io/vscode-codicons/dist/codicon.html#source-control
 *
 * Implementation note: we use 3 explicit <Circle> nodes + a 2-segment
 * <Path> for the trunk. This avoids the complex single-path codicon
 * SVG (which relies on fillRule="evenodd" to carve circles out of a
 * compound body and rendered as a person silhouette in react-native-svg
 * — see the 2026-05-31 02:38 user screenshot).
 */
export function CodiconSourceControl({
  size = 20,
  color = "currentColor",
}: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      {/* Y-branch trunk: vertical from top node to bottom node,
          horizontal kick out at the midpoint to the right node. */}
      <Path
        d="M5 4.25 V 11.75 M 5 8 H 10.5"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* Top-left endpoint */}
      <Circle cx="5" cy="3" r="1.6" fill={color} />
      {/* Bottom-left endpoint */}
      <Circle cx="5" cy="13" r="1.6" fill={color} />
      {/* Right endpoint */}
      <Circle cx="12" cy="8" r="1.6" fill={color} />
    </Svg>
  );
}

/**
 * VS Code "debug-alt" codicon — the bug glyph VS Code uses for its
 * Run and Debug activity bar entry. Rounded oblong body, two antennae,
 * three pairs of legs, and a faint center seam.
 *
 * Reference: https://microsoft.github.io/vscode-codicons/dist/codicon.html#debug-alt
 *
 * Implementation note: we draw the body as a single rounded path
 * (M…c…c…c…c… closed shape) and the antennae/legs as 8 separate
 * strokes. Strokes are 1.2 wide with rounded caps to match the
 * Codicon weight at activity-bar size (~20px).
 */
export function CodiconRunDebug({
  size = 20,
  color = "currentColor",
}: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      {/* Bug body — capsule, ~3 wide × ~6 tall, centered at (8, 9) */}
      <Path
        fill={color}
        d="M8 5
           c -1.66 0 -3 1.34 -3 3
           v 3
           c 0 1.66 1.34 3 3 3
           s 3 -1.34 3 -3
           v -3
           c 0 -1.66 -1.34 -3 -3 -3
           z"
      />
      {/* Faint center seam — subtle darker stripe down the body */}
      <Path
        d="M8 5.4 V 13.6"
        stroke="rgba(0,0,0,0.35)"
        strokeWidth="0.6"
        fill="none"
      />
      {/* Two antennae rising from the head */}
      <Path
        d="M6.5 5.4 L 5.2 3.8 M 9.5 5.4 L 10.8 3.8"
        stroke={color}
        strokeWidth="1.1"
        strokeLinecap="round"
        fill="none"
      />
      {/* Left flank — three legs angling out and down */}
      <Path
        d="M5 8.4 L 3.2 7.7
           M 5 10.7 L 3.2 11.2
           M 5 12.7 L 3.5 13.8"
        stroke={color}
        strokeWidth="1.1"
        strokeLinecap="round"
        fill="none"
      />
      {/* Right flank — three legs (mirrored) */}
      <Path
        d="M11 8.4 L 12.8 7.7
           M 11 10.7 L 12.8 11.2
           M 11 12.7 L 12.5 13.8"
        stroke={color}
        strokeWidth="1.1"
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

export function CodiconExtensions({
  size = 20,
  color = "currentColor",
}: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path
        d="M2.25 2.25h4.9v4.9h-4.9z M2.25 8.85h4.9v4.9h-4.9z M8.85 8.85h4.9v4.9h-4.9z M10.65 1.6 14.4 5.35 10.65 9.1 6.9 5.35Z"
        stroke={color}
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
