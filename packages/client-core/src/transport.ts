import {
  errorCodeOf,
  fillPath,
  type AnswerOf,
  type BodyIn,
  type Endpoint,
  type EndpointSpec,
  type ErrorCode,
  type ParamsIn,
  type QueryIn,
} from "@ownbase/protocol";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message?: string,
    /** How long the server asked to be left alone, from its Retry-After, when it said. */
    public retryAfterMs?: number,
  ) {
    super(message ?? code);
  }
}

/** Retry-After in seconds as milliseconds; a date or nothing gives undefined. */
function retryAfter(header: string | null): number | undefined {
  const seconds = Number(header);
  return header && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** A refusal as the server words it, `{ error, message }`, from any answer that is not a success. */
export function apiError(status: number, text: string, retryAfterHeader: string | null): ApiError {
  let code: ErrorCode = "http_error";
  let message: string | undefined;
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown };
    code = errorCodeOf(data.error);
    if (typeof data.message === "string") message = data.message;
  } catch {
    /* not JSON */
  }
  return new ApiError(status, code, message, retryAfter(retryAfterHeader));
}

async function refusal(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  return apiError(res.status, text, res.headers.get("retry-after"));
}

type BodyGiven<B> = B extends "image" ? Blob : B extends "slack" ? unknown : BodyIn<{ body: B }>;

// A file goes as a form of its own, beside the input: see `upload`.
type BodyPart<E> = E extends { body: infer B }
  ? B extends "file"
    ? { body?: undefined }
    : E extends { bodyOptional: true }
      ? { body?: BodyGiven<B> }
      : { body: BodyGiven<B> }
  : { body?: undefined };

/** What a call names: its path's parameters, its query and its body, as the endpoint declares. */
export type CallInput<E extends EndpointSpec> = ([keyof ParamsIn<E>] extends [never]
  ? { params?: undefined }
  : { params: ParamsIn<E> }) &
  (E extends { query: object } ? { query?: QueryIn<E> } : { query?: undefined }) &
  BodyPart<E>;

export interface CallOptions {
  signal?: AbortSignal;
}

/** The arguments of a call: the input may be left out when nothing in it is required. */
export type CallArgs<E extends EndpointSpec> =
  Record<string, never> extends CallInput<E>
    ? [input?: CallInput<E>, opts?: CallOptions]
    : [input: CallInput<E>, opts?: CallOptions];

/**
 * The one way this client reaches a workspace server: the URL built from an
 * endpoint's declaration, its path ids always encoded, the session sent with
 * it, the endpoint's own timeout, and every refusal read into an `ApiError`.
 */
export class Transport {
  constructor(
    public baseUrl: string,
    private token: string | null = null,
  ) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  url(endpoint: EndpointSpec, input: { params?: unknown; query?: unknown } = {}): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries((input.query ?? {}) as object))
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    const path = fillPath(endpoint.path, input.params as Record<string, unknown> | undefined);
    return `${this.baseUrl}${path}${query.size > 0 ? `?${query}` : ""}`;
  }

  private headers(contentType?: string): Record<string, string> {
    return {
      ...(contentType ? { "content-type": contentType } : {}),
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private signal(endpoint: Endpoint, signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(endpoint.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  /** Calls a JSON route. A Blob is sent as itself, with its own type; any other body as JSON. */
  async json<E extends Endpoint>(endpoint: E, ...[input, opts]: CallArgs<E>): Promise<AnswerOf<E>> {
    const body = (input as { body?: unknown } | undefined)?.body;
    const file = typeof Blob !== "undefined" && body instanceof Blob ? body : null;
    const res = await fetch(this.url(endpoint, input), {
      method: endpoint.method,
      headers: this.headers(
        body === undefined
          ? undefined
          : file
            ? file.type || "application/octet-stream"
            : "application/json",
      ),
      body: file ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: this.signal(endpoint, opts?.signal),
    });
    if (!res.ok) throw await refusal(res);
    return (await res.json()) as AnswerOf<E>;
  }

  /** Reads the bytes of a file or picture. */
  async bytes<E extends Endpoint>(endpoint: E, ...[input, opts]: CallArgs<E>): Promise<Blob> {
    const res = await fetch(this.url(endpoint, input), {
      headers: this.headers(),
      signal: this.signal(endpoint, opts?.signal),
    });
    if (!res.ok) throw await refusal(res);
    return res.blob();
  }

  /**
   * Sends a form with one file, reporting how much has gone. XMLHttpRequest
   * rather than fetch: only it reports an upload's progress.
   */
  upload<E extends Endpoint>(
    endpoint: E,
    input: CallInput<E>,
    form: FormData,
    opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ): Promise<AnswerOf<E>> {
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new ApiError(0, "aborted"));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open(endpoint.method, this.url(endpoint, input));
      xhr.timeout = endpoint.timeoutMs;
      for (const [name, value] of Object.entries(this.headers())) xhr.setRequestHeader(name, value);
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(apiError(xhr.status, xhr.responseText, xhr.getResponseHeader("retry-after")));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText) as AnswerOf<E>);
        } catch {
          reject(new ApiError(0, "invalid_response"));
        }
      });
      xhr.addEventListener("error", () => reject(new ApiError(0, "network_error")));
      xhr.addEventListener("abort", () => reject(new ApiError(0, "aborted")));
      xhr.addEventListener("timeout", () => reject(new ApiError(0, "upload_timeout")));
      const abort = () => xhr.abort();
      opts.signal?.addEventListener("abort", abort, { once: true });
      xhr.addEventListener("loadend", () => opts.signal?.removeEventListener("abort", abort));
      xhr.send(form);
    });
  }

  /**
   * Posts to an incoming webhook at the address the server gave it, the way
   * any other tool would. The address is the webhook's whole authority, so no
   * session goes with it, and success is Slack's plain-text "ok".
   */
  async postToWebhook(endpoint: Endpoint, url: string, payload: unknown): Promise<void> {
    const res = await fetch(url, {
      method: endpoint.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: this.signal(endpoint),
    });
    if (!res.ok) throw await refusal(res);
  }
}
