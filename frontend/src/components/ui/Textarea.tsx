import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, error, id, ...rest },
  ref,
) {
  return (
    <div className="space-y-1">
      <textarea
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error && id ? `${id}-error` : undefined}
        className={cn(
          "min-h-28 w-full rounded-lg border bg-surface px-3 py-2 text-sm text-ink",
          "placeholder:text-ink-subtle",
          error ? "border-status-failed" : "border-line focus:border-brand",
          className,
        )}
        {...rest}
      />
      {error ? (
        <p id={id ? `${id}-error` : undefined} className="text-xs text-status-failed">
          {error}
        </p>
      ) : null}
    </div>
  );
});
