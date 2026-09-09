import Papa from "papaparse";

export interface Recipient {
  email: string;
  name: string | null;
}

export interface InvalidCsvRow {
  row: number;
  value: string;
  reason: string;
}

export interface CsvParseResult {
  recipients: Recipient[];
  invalidRows: InvalidCsvRow[];
  totalRows: number;
  duplicateCount: number;
}

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isValidEmail(value: string): boolean {
  if (value.length > 254) return false;
  return EMAIL_RE.test(value);
}

function looksLikeHeader(cell: string): boolean {
  const n = cell.trim().toLowerCase();
  return n === "email" || n === "e-mail" || n === "mail" || n === "email_address" || n === "emailaddress";
}

function looksLikeNameHeader(cell: string): boolean {
  const n = cell.trim().toLowerCase();
  return n === "name" || n === "full name" || n === "fullname" || n === "recipient";
}

/**
 * Parse a CSV/text buffer of leads into a unique, validated recipient list.
 *
 * Accepts a single-column dump or a headered file with an email column (and an
 * optional name column). Duplicate addresses (case-insensitive) keep the first
 * occurrence. Invalid rows are reported, not silently dropped without a trace.
 */
export function parseRecipientCsv(
  input: string | Buffer,
  options: { maxRecipients: number } = { maxRecipients: 50_000 },
): CsvParseResult {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: "greedy",
    transform: (value: string) => value.trim(),
  });

  const rows = (parsed.data ?? []).filter((row) => row.some((cell) => cell.length > 0));
  if (rows.length === 0) {
    return { recipients: [], invalidRows: [], totalRows: 0, duplicateCount: 0 };
  }

  const first = rows[0] ?? [];
  const headered = first.some((cell) => looksLikeHeader(cell));
  let emailIdx = 0;
  let nameIdx: number | null = null;
  let dataStart = 0;

  if (headered) {
    emailIdx = first.findIndex((cell) => looksLikeHeader(cell));
    if (emailIdx < 0) emailIdx = 0;
    const foundName = first.findIndex((cell) => looksLikeNameHeader(cell));
    nameIdx = foundName >= 0 ? foundName : null;
    dataStart = 1;
  } else if (first.length > 1) {
    // Headerless but multi-column: first column that contains an @ wins.
    const withAt = first.findIndex((cell) => cell.includes("@"));
    emailIdx = withAt >= 0 ? withAt : 0;
    nameIdx = emailIdx === 0 && first.length > 1 ? 1 : 0;
    if (nameIdx === emailIdx) nameIdx = null;
  }

  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  const invalidRows: InvalidCsvRow[] = [];
  let duplicateCount = 0;

  for (let i = dataStart; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const raw = (row[emailIdx] ?? "").trim();
    const displayName = nameIdx !== null ? (row[nameIdx] ?? "").trim() || null : null;
    const lineNumber = i + 1;

    if (!raw) {
      invalidRows.push({ row: lineNumber, value: raw, reason: "empty" });
      continue;
    }

    const email = raw.toLowerCase();
    if (!isValidEmail(email)) {
      invalidRows.push({ row: lineNumber, value: raw, reason: "invalid_email" });
      continue;
    }

    if (seen.has(email)) {
      duplicateCount += 1;
      continue;
    }

    if (recipients.length >= options.maxRecipients) {
      invalidRows.push({
        row: lineNumber,
        value: email,
        reason: `exceeds_max_recipients_${options.maxRecipients}`,
      });
      continue;
    }

    seen.add(email);
    recipients.push({ email, name: displayName });
  }

  return {
    recipients,
    invalidRows,
    totalRows: rows.length - dataStart,
    duplicateCount,
  };
}
