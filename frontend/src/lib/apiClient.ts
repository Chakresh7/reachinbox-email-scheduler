import type { ApiErrorBody, ApiErrorCode } from "../types/api";

/**
 * The single path every request takes to the backend.
 *
 * Requests go to a relative URL so the Vite dev proxy (and one origin in
 * production) keeps the session cookie same-origin. `credentials: "include"` is
 * set on every call, because the session is an httpOnly cookie and a request
 * without it just looks unauthenticated.
 */

/** Error carrying the server's machine-readable code, so callers can branch. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    options: { details?: unknown; requestId?: string } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.requestId = options.requestId;
  }

  /** True when re-authenticating could plausibly fix this. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/**
 * Notifies the app when the session has expired.
 *
 * A callback registry rather than a redirect inside the client: the client has
 * no business knowing about routing, and during tests there is no router at
 * all.
 */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** Serialised as JSON unless it is FormData, which is passed through. */
  body?: unknown;
  /** Appended as a query string, skipping null/undefined values. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Sent as the Idempotency-Key header, for safe retries of a POST. */
  idempotencyKey?: string;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function parseError(response: Response): Promise<ApiError> {
  let code: ApiErrorCode = "INTERNAL";
  let message = `Request failed with status ${response.status}`;
  let details: unknown;
  let requestId: string | undefined = response.headers.get("x-request-id") ?? undefined;

  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
      requestId = body.error.requestId ?? requestId;
    }
  } catch {
    // A non-JSON error body (a proxy 502, an HTML error page) is expected
    // occasionally; the status-derived message above is the best available.
  }

  return new ApiError(response.status, code, message, { details, requestId });
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, idempotencyKey, headers, ...rest } = options;

  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const requestHeaders = new Headers(headers);
  if (body !== undefined && !isFormData) {
    requestHeaders.set("Content-Type", "application/json");
  }
  if (idempotencyKey) {
    requestHeaders.set("Idempotency-Key", idempotencyKey);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      ...rest,
      headers: requestHeaders,
      // Always: the session cookie is the only credential.
      credentials: "include",
      ...(body !== undefined
        ? { body: isFormData ? (body as FormData) : JSON.stringify(body) }
        : {}),
    });
  } catch (cause) {
    // fetch only rejects on a transport failure, so this is genuinely "the API
    // is unreachable" rather than an HTTP error status.
    throw new ApiError(0, "NETWORK", "Cannot reach the API. Is the backend running?", {
      details: cause,
    });
  }

  if (response.status === 401) {
    for (const listener of unauthorizedListeners) listener();
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, "body" | "method">) =>
    request<T>(path, { ...options, method: "GET" }),

  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "body" | "method">) =>
    request<T>(path, { ...options, method: "POST", body }),

  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "body" | "method">) =>
    request<T>(path, { ...options, method: "PATCH", body }),

  delete: <T>(path: string, options?: Omit<RequestOptions, "body" | "method">) =>
    request<T>(path, { ...options, method: "DELETE" }),
};
