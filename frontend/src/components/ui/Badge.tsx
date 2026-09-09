import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type BadgeTone = "scheduled" | "sent" | "failed" | "ratelimited" | "neutral" | "brand";

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
  title?: string;
}

const toneStyles: Record<BadgeTone, string> = {
  scheduled: "bg-status-scheduled-bg text-status-scheduled",
  sent: "bg-status-sent-bg text-status-sent",
  failed: "bg-status-failed-bg text-status-failed",
  ratelimited: "bg-status-ratelimited-bg text-status-ratelimited",
  neutral: "bg-status-neutral-bg text-status-neutral",
  brand: "bg-brand-subtle text-brand",
};

export function Badge({ tone = "neutral", children, icon, className, title }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        toneStyles[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
