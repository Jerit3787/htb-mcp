import type { AppConfig } from "./config.js";
import { HtbError } from "./errors.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export type ApiVersion = "v4" | "v5";
export type HttpMethod = "GET" | "POST";
export type QueryValue =
  | string
  | number
  | boolean
  | readonly (string | number)[]
  | undefined;

export interface HtbRequestOptions {
  version?: ApiVersion;
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  body?: unknown;
  responseType?: "json" | "text";
  retry?: boolean;
}

type FetchLike = typeof fetch;

export class HtbClient {
  readonly config: AppConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: AppConfig, fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async get<T>(path: string, options: Omit<HtbRequestOptions, "method"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  async post<T>(path: string, options: Omit<HtbRequestOptions, "method"> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST" });
  }

  async request<T>(path: string, options: HtbRequestOptions = {}): Promise<T> {
    if (!this.config.token && !this.config.sessionCookie) {
      throw new HtbError({
        code: "AUTH_MISSING",
        message: "No Hack The Box credentials configured.",
        hint: "Set HTB_TOKEN to an App Token from https://app.hackthebox.com/settings (or HTB_SESSION_COOKIE).",
      });
    }

    const method = options.method ?? "GET";
    const version = options.version ?? "v4";
    const endpoint = `${version}:${path}`;
    const url = this.buildUrl(version, path, options.query);
    const maxAttempts = this.shouldRetry(method, options) ? this.config.maxRetries + 1 : 1;
    let lastError: HtbError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      let response: Response;

      try {
        const init: RequestInit = {
          method,
          headers: this.headers(options.body !== undefined),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        };
        if (options.body !== undefined) {
          init.body = JSON.stringify(options.body);
        }
        response = await this.fetchImpl(url, init);
      } catch (error) {
        const timedOut =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        lastError = new HtbError({
          code: "NETWORK_ERROR",
          message: timedOut
            ? `HTB request timed out after ${this.config.timeoutMs}ms.`
            : `Could not reach HTB: ${error instanceof Error ? error.message : String(error)}`,
          endpoint,
          hint: "Check your network connection and HTB_LABS_URL.",
        });

        if (attempt < maxAttempts && method === "GET") {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (response.status === 429) {
        lastError = new HtbError({
          code: "RATE_LIMITED",
          message: "HTB rate limit reached.",
          status: 429,
          endpoint,
          hint: `Retry in ${Math.ceil(retryAfterMs(response, attempt) / 1000)}s. HTB also limits machine actions to one per minute.`,
        });
        if (attempt < maxAttempts) {
          await sleep(retryAfterMs(response, attempt));
          continue;
        }
        throw lastError;
      }

      if (response.status >= 500 && method === "GET" && attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }

      if (!response.ok) {
        throw await this.errorFromResponse(response, endpoint);
      }

      return await this.parseSuccess<T>(response, endpoint, options.responseType ?? "json", startedAt);
    }

    throw (
      lastError ??
      new HtbError({
        code: "API_ERROR",
        message: "HTB request failed.",
        endpoint,
      })
    );
  }

  private shouldRetry(method: HttpMethod, options: HtbRequestOptions): boolean {
    if (options.retry === false) {
      return false;
    }
    // A 429 means HTB rejected the request before any action occurred, so POSTs
    // are safe to retry there. Do not retry POSTs on network errors or 5xx.
    return method === "GET" || method === "POST";
  }

  private buildUrl(
    version: ApiVersion,
    path: string,
    query: Record<string, QueryValue> | undefined,
  ): URL {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.config.labsUrl}/api/${version}${normalizedPath}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === "") {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  private headers(hasBody: boolean): Headers {
    const headers = new Headers({
      Accept: "application/json",
      "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
      Origin: "https://app.hackthebox.com",
      Referer: "https://app.hackthebox.com/",
    });

    if (this.config.token) {
      headers.set("Authorization", `Bearer ${this.config.token}`);
    }
    if (this.config.sessionCookie) {
      headers.set("Cookie", this.config.sessionCookie);
    }
    if (hasBody) {
      headers.set("Content-Type", "application/json");
    }

    return headers;
  }

  private async parseSuccess<T>(
    response: Response,
    endpoint: string,
    responseType: "json" | "text",
    startedAt: number,
  ): Promise<T> {
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const looksLikeHtml =
      contentType.includes("text/html") ||
      /^\s*<(?:!doctype|html)/i.test(text.slice(0, 256));

    if (looksLikeHtml) {
      throw new HtbError({
        code: "INVALID_RESPONSE",
        message: "HTB returned an HTML page instead of API JSON.",
        status: response.status,
        endpoint,
        hint: "The App Token may be invalid, or the API moved. Check HTB_LABS_URL (default https://labs.hackthebox.com).",
        details: {
          contentType,
          elapsedMs: Date.now() - startedAt,
        },
      });
    }

    if (responseType === "text") {
      return text as T;
    }

    if (text.trim() === "") {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HtbError({
        code: "INVALID_RESPONSE",
        message: "HTB returned a response that was not valid JSON.",
        status: response.status,
        endpoint,
        details: {
          contentType,
          preview: text.slice(0, 300),
        },
      });
    }
  }

  private async errorFromResponse(response: Response, endpoint: string): Promise<HtbError> {
    const text = await response.text();
    let message = response.statusText || `HTTP ${response.status}`;
    let details: unknown;

    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const candidate =
        body.message ??
        body.error ??
        (Array.isArray(body.errors) ? body.errors.flat().join("; ") : undefined);
      if (typeof candidate === "string" && candidate.trim()) {
        message = candidate.trim();
      } else if (candidate !== undefined) {
        message = String(candidate);
      }
      details = body;
    } catch {
      if (text.trim() && !/^\s*</.test(text)) {
        message = text.trim().slice(0, 500);
      }
    }

    if (response.status === 401 || response.status === 403) {
      return new HtbError({
        code: "AUTH_FAILED",
        message: `HTB authentication failed (${response.status}): ${message}`,
        status: response.status,
        endpoint,
        hint: "Refresh HTB_TOKEN. If the token works in the browser but not here, try setting HTB_SESSION_COOKIE.",
        details,
      });
    }

    if (response.status === 404) {
      return new HtbError({
        code: "NOT_FOUND",
        message: `HTB resource not found: ${message}`,
        status: 404,
        endpoint,
        hint: "Check the machine/challenge name or ID.",
        details,
      });
    }

    if (response.status === 409) {
      return new HtbError({
        code: "CONFLICT",
        message: `HTB rejected the action: ${message}`,
        status: 409,
        endpoint,
        details,
      });
    }

    if (/wait .*minute|too many requests|rate limit/i.test(message)) {
      return new HtbError({
        code: "RATE_LIMITED",
        message: `HTB rate limit: ${message}`,
        status: response.status,
        endpoint,
        hint: "Wait for the advertised cooldown before retrying.",
        details,
      });
    }

    return new HtbError({
      code: "API_ERROR",
      message: `HTB API error (${response.status}): ${message}`,
      status: response.status,
      endpoint,
      details,
    });
  }
}

function retryAfterMs(response: Response, attempt: number): number {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number.parseInt(raw, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }
    const date = Date.parse(raw);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(date - Date.now(), 0), 60_000);
    }
  }
  return backoffMs(attempt);
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
