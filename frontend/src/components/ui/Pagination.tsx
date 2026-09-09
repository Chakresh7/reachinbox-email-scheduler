import { cn } from "../../lib/cn";
import { Button } from "./Button";

export interface PaginationProps {
  page: number;
  totalPages: number;
  total?: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export function Pagination({ page, totalPages, total, onPageChange, className }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className={cn("flex items-center justify-between gap-3 border-t border-line px-5 py-3", className)}>
      <p className="text-xs text-ink-muted">
        Page {page} of {totalPages}
        {typeof total === "number" ? ` · ${total} total` : ""}
      </p>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
