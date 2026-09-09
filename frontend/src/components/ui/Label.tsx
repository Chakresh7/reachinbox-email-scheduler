import type { LabelHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Label({ className, children, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn("block text-sm font-medium text-ink", className)} {...rest}>
      {children}
    </label>
  );
}
