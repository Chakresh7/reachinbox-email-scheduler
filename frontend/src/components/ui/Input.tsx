import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, error, id, ...rest },
  ref,
) {
  return (
    <div className="space-y-1">
      <input
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error && id ? `${id}-error` : undefined}
        className={cn(
          "h-10 w-full rounded-lg border bg-surface px-3 text-sm text-ink",
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
