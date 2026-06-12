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
 * VS Code "source-control" codicon — three outlined circles connected by
 * a Y-branch. Two endpoints are stacked on the left and one endpoint
 * protrudes to the right.
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
      <Path
        d="M5 4.95 V 11.05 M6.25 9.1 10.05 6.9"
        stroke={color}
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx="5" cy="3" r="1.65" stroke={color} strokeWidth="1.35" fill="none" />
      <Circle cx="5" cy="13" r="1.65" stroke={color} strokeWidth="1.35" fill="none" />
      <Circle cx="12" cy="5.8" r="1.65" stroke={color} strokeWidth="1.35" fill="none" />
    </Svg>
  );
}

/**
 * VS Code "debug-alt" codicon — the outlined play + bug glyph VS Code uses
 * for its Run and Debug activity bar entry.
 *
 * Reference: https://microsoft.github.io/vscode-codicons/dist/codicon.html#debug-alt
 *
 * Implementation note: the play triangle and bug are separate stroked paths
 * so the outline remains crisp at activity-bar size.
 */
export function CodiconRunDebug({
  size = 20,
  color = "currentColor",
}: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path
        d="M7.75 2.35 14 6.15 7.75 9.95Z"
        stroke={color}
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M5.3 8.2
           c -1.55 0 -2.8 1.25 -2.8 2.8
           v 1.05
           c 0 1.55 1.25 2.8 2.8 2.8
           s 2.8 -1.25 2.8 -2.8
           V 11
           c 0 -1.55 -1.25 -2.8 -2.8 -2.8
           z"
        stroke={color}
        strokeWidth="1.25"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M3.4 8.7 2.35 7.45 M7.2 8.7 8.25 7.45
           M2.55 10.45 H1.2 M8.05 10.45 H9.4
           M2.55 12.35 H1.2 M8.05 12.35 H9.4
           M3 14.05 1.9 15.1 M7.6 14.05 8.7 15.1"
        stroke={color}
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
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
