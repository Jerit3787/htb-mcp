export type HtbErrorCode =
  | "AUTH_MISSING"
  | "AUTH_FAILED"
  | "API_ERROR"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VPN_ERROR"
  | "OPENVPN_ERROR";

export interface HtbErrorOptions {
  code: HtbErrorCode;
  message: string;
  status?: number;
  endpoint?: string;
  hint?: string;
  details?: unknown;
}

export class HtbError extends Error {
  readonly code: HtbErrorCode;
  readonly status: number | undefined;
  readonly endpoint: string | undefined;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(options: HtbErrorOptions) {
    super(options.message);
    this.name = "HtbError";
    this.code = options.code;
    this.status = options.status;
    this.endpoint = options.endpoint;
    this.hint = options.hint;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function toHtbError(error: unknown): HtbError {
  if (error instanceof HtbError) {
    return error;
  }

  if (error instanceof Error) {
    return new HtbError({
      code: "API_ERROR",
      message: error.message,
    });
  }

  return new HtbError({
    code: "API_ERROR",
    message: String(error),
  });
}
