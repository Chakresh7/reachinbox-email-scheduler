import { cn } from "../../lib/cn";

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

export interface TabsProps<T extends string> {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: TabsProps<T>) {
  return (
    <div role="tablist" className={cn("flex gap-1 rounded-lg bg-surface-sunken p-1", className)}>
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              const delta = event.key === "ArrowRight" ? 1 : -1;
              const next = tabs[(index + delta + tabs.length) % tabs.length];
              if (next) onChange(next.id);
            }}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium",
              selected ? "bg-surface text-ink shadow-sm" : "text-ink-muted hover:text-ink",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
