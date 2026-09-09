import { cn } from "../../lib/cn";

export interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Screen-reader label. Set to null inside a container that already has one. */
  label?: string | null;
}

const sizeStyles = {
  sm: "size-4 border-2",
  md: "size-6 border-2",
  lg: "size-8 border-[3px]",
} as const;

export function Spinner({ size = "md", className, label = "Loading" }: SpinnerProps) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label ?? undefined}
      className={cn(
        "inline-block animate-spin rounded-full border-current border-t-transparent",
        sizeStyles[size],
        className,
      )}
    />
  );
}
