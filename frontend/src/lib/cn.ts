import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conditional class names with Tailwind conflict resolution.
 *
 * `twMerge` is what makes the UI primitives genuinely reusable: a caller can
 * pass `className="px-6"` to a Button whose base style is `px-4` and get `px-6`,
 * instead of both classes landing in the DOM and the winner depending on
 * stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
