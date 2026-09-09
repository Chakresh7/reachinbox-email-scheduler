import { cn } from "../../lib/cn";

export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-surface-sunken", className)}
    />
  );
}

export interface SkeletonRowsProps {
  rows?: number;
  columns?: number;
  className?: string;
}

/**
 * Table loading placeholder.
 *
 * Skeleton rows rather than a centred spinner, because they preserve the layout
 * height and stop the page from jumping when real data arrives.
 */
export function SkeletonRows({ rows = 5, columns = 4, className }: SkeletonRowsProps) {
  return (
    <div className={cn("divide-y divide-line", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4 px-5 py-3.5">
          {Array.from({ length: columns }, (_, colIndex) => (
            <Skeleton
              key={colIndex}
              className={cn("h-4", colIndex === 0 ? "w-1/3" : "flex-1")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
