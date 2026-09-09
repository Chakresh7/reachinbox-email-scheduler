import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useCreateCampaign, usePreviewCsv } from "../../hooks/useCreateCampaign";
import { ApiError } from "../../lib/apiClient";
import { Button } from "../ui/Button";
import { FileDropzone } from "../ui/FileDropzone";
import { Input } from "../ui/Input";
import { Label } from "../ui/Label";
import { Modal } from "../ui/Modal";
import { Textarea } from "../ui/Textarea";

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface ComposeEmailModalProps {
  open: boolean;
  onClose: () => void;
}

export function ComposeEmailModal({ open, onClose }: ComposeEmailModalProps) {
  const subjectId = useId();
  const bodyId = useId();
  const startId = useId();
  const delayId = useId();
  const limitId = useId();

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [startAt, setStartAt] = useState(() => toLocalInputValue(new Date()));
  const [delaySeconds, setDelaySeconds] = useState("2");
  const [hourlyLimit, setHourlyLimit] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const lastErrorWasNetwork = useRef(false);

  const preview = usePreviewCsv();
  const create = useCreateCampaign();

  useEffect(() => {
    if (!open) return;
    setSubject("");
    setBody("");
    setStartAt(toLocalInputValue(new Date()));
    setDelaySeconds("2");
    setHourlyLimit("");
    setFile(null);
    preview.reset();
    create.reset();
    idempotencyKey.current = crypto.randomUUID();
    lastErrorWasNetwork.current = false;
    // preview/create identities are stable mutation objects; reset on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function onFile(next: File | null) {
    setFile(next);
    preview.reset();
    if (next) preview.mutate(next);
  }

  const validEmails = preview.data?.validEmails ?? 0;
  const canSubmit =
    subject.trim().length > 0 &&
    body.trim().length > 0 &&
    file !== null &&
    validEmails > 0 &&
    !preview.isPending &&
    !create.isPending;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!file || !canSubmit) return;

    const start = new Date(startAt);
    if (Number.isNaN(start.getTime())) return;
    const delayMs = Number(delaySeconds) * 1000;
    if (!Number.isFinite(delayMs) || delayMs < 0) return;
    const limitRaw = hourlyLimit.trim();
    const limit = limitRaw === "" ? null : Number(limitRaw);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) return;

    if (!lastErrorWasNetwork.current) {
      idempotencyKey.current = crypto.randomUUID();
    }

    try {
      await create.mutateAsync({
        subject: subject.trim(),
        body: body.trim(),
        startAt: start,
        delayBetweenMs: delayMs,
        hourlyLimit: limit,
        file,
        idempotencyKey: idempotencyKey.current,
      });
      lastErrorWasNetwork.current = false;
      onClose();
    } catch (err) {
      lastErrorWasNetwork.current = err instanceof ApiError && err.code === "NETWORK";
    }
  }

  return (
    <Modal open={open} title="Compose New Email" onClose={onClose}>
      <form className="space-y-4" onSubmit={(event) => void onSubmit(event)}>
        <div className="space-y-1.5">
          <Label htmlFor={subjectId}>Subject</Label>
          <Input
            id={subjectId}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            required
            maxLength={200}
            placeholder="Campaign subject"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={bodyId}>Body</Label>
          <Textarea
            id={bodyId}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
            placeholder="Email body"
          />
        </div>

        <div className="space-y-1.5">
          <Label>Recipients (CSV or text)</Label>
          <FileDropzone file={file} onFile={onFile} disabled={create.isPending} />
          {preview.isPending ? (
            <p className="text-xs text-ink-muted">Detecting addresses…</p>
          ) : preview.isError ? (
            <p className="text-xs text-status-failed">
              {preview.error instanceof ApiError ? preview.error.message : "Could not parse the file"}
            </p>
          ) : preview.data ? (
            <p className="text-xs text-ink-muted">
              {preview.data.validEmails} email{preview.data.validEmails === 1 ? "" : "s"} detected
              {preview.data.duplicates > 0 ? ` · ${preview.data.duplicates} duplicate${preview.data.duplicates === 1 ? "" : "s"} skipped` : ""}
              {preview.data.invalidRows.length > 0
                ? ` · ${preview.data.invalidRows.length} invalid row${preview.data.invalidRows.length === 1 ? "" : "s"}`
                : ""}
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-1">
            <Label htmlFor={startId}>Start time</Label>
            <Input
              id={startId}
              type="datetime-local"
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={delayId}>Delay (seconds)</Label>
            <Input
              id={delayId}
              type="number"
              min={0}
              step={1}
              value={delaySeconds}
              onChange={(event) => setDelaySeconds(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={limitId}>Hourly limit</Label>
            <Input
              id={limitId}
              type="number"
              min={1}
              step={1}
              value={hourlyLimit}
              onChange={(event) => setHourlyLimit(event.target.value)}
              placeholder="Default"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!canSubmit}>
            Schedule
          </Button>
        </div>
      </form>
    </Modal>
  );
}
