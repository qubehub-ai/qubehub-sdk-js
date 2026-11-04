/**
 * Thrown when the Partner Data API responds with a non-2xx status (a redirect
 * included), or with a 2xx body the SDK cannot read as JSON. Network errors and
 * aborts are not wrapped: they propagate from `fetch` unchanged.
 *
 * Branch on `errorCode` (the `error_code` field of the error envelope), never on
 * `message`: codes are stable, human messages may change.
 */
export class QubeHubApiError extends Error {
  /** HTTP status of the response. */
  readonly status: number;
  /** The stable `error_code` from the error envelope, e.g. `INSUFFICIENT_SCOPE`; null when the response carried none. */
  readonly errorCode: string | null;
  /** Structured context from the envelope's `details`, e.g. the missing scope or the invalid fields. */
  readonly details: unknown;
  /** Seconds from the `Retry-After` response header, when the server sent it as a number of seconds. */
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    status: number;
    message: string;
    errorCode: string | null;
    details: unknown;
    retryAfterSeconds: number | null;
  }) {
    super(init.message);
    this.name = "QubeHubApiError";
    this.status = init.status;
    this.errorCode = init.errorCode;
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** Thrown by `parseWebhookEvent` when a delivery body is not a QubeHub webhook event. */
export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}
