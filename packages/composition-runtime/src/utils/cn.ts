/**
 * Class name utility combining clsx and tailwind-merge
 *
 * This utility enables:
 * - Conditional class names via clsx
 * - Proper Tailwind class merging (avoiding conflicts)
 */

import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
