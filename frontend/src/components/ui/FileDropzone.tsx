import { useRef, useState, type DragEvent, type ChangeEvent } from "react";
import { Upload } from "lucide-react";
import { cn } from "../../lib/cn";

/** Matches backend MAX_CSV_BYTES default. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

export interface FileDropzoneProps {
  file: File | null;
  onFile: (file: File | null) => void;
  accept?: string;
  maxBytes?: number;
  error?: string;
  disabled?: boolean;
}

export function FileDropzone({
  file,
  onFile,
  accept = ".csv,.txt,text/csv,text/plain",
  maxBytes = MAX_CSV_BYTES,
  error,
  disabled,
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  function applyFile(next: File | null) {
    setLocalError(null);
    if (!next) {
      onFile(null);
      return;
    }
    if (next.size > maxBytes) {
      setLocalError(`File exceeds ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`);
      onFile(null);
      return;
    }
    onFile(next);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    applyFile(event.dataTransfer.files[0] ?? null);
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    applyFile(event.target.files?.[0] ?? null);
    event.target.value = "";
  }

  const message = error ?? localError;

  return (
    <div className="space-y-1">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center",
          dragging ? "border-brand bg-brand-subtle" : "border-line bg-surface-muted",
          disabled && "cursor-not-allowed opacity-50",
          message && "border-status-failed",
        )}
      >
        <Upload className="size-5 text-ink-muted" />
        <div className="text-sm text-ink">
          {file ? (
            <span className="font-medium">{file.name}</span>
          ) : (
            <>
              Drop a CSV or text file, or <span className="text-brand">browse</span>
            </>
          )}
        </div>
        <p className="text-xs text-ink-subtle">One email per line, or a file with an email column.</p>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          disabled={disabled}
          onChange={onChange}
        />
      </div>
      {file ? (
        <button
          type="button"
          className="text-xs text-ink-muted hover:text-ink"
          onClick={() => applyFile(null)}
        >
          Remove file
        </button>
      ) : null}
      {message ? <p className="text-xs text-status-failed">{message}</p> : null}
    </div>
  );
}
