import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookPayloadError } from "./errors.js";
import { isRecord } from "./guards.js";

/** Headers QubeHub sends with every webhook delivery. */
export const WEBHOOK_HEADERS = {
  /** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`; present when the webhook has a secret. */
  signature: "X-Signature-256",
  /** Stable across every retry of one delivery: use it as your idempotency key. */
  deliveryId: "X-Delivery-Id",
  webhookId: "X-Webhook-Id",
  eventType: "X-Event-Type",
  entityType: "X-Entity-Type",
} as const;

/** How far the signed timestamp may be from your clock before a delivery is rejected as a replay. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

const SHA256_HEX_LENGTH = 64;
const HEX_PATTERN = /^[0-9a-f]+$/i;
const TIMESTAMP_PATTERN = /^\d+$/;
const SIGNATURE_SCHEME = "v1";
const MS_PER_SECOND = 1000;

export interface VerifyWebhookSignatureOptions {
  /** The raw request body exactly as received, before any JSON parsing. */
  payload: string | Uint8Array;
  /** The value of the `X-Signature-256` header. */
  signature: string | null | undefined;
  /** The signing secret configured on the webhook in the CRM. */
  secret: string;
  /** Maximum age, in seconds, of the signed timestamp. Defaults to 300. */
  toleranceSeconds?: number;
  /** The current time, for tests. Defaults to `Date.now()`. */
  now?: Date;
}

/**
 * Checks the `X-Signature-256` header of a QubeHub webhook delivery: an
 * HMAC-SHA256, keyed with the webhook's secret, of `"<t>.<raw body>"`, sent as
 * `t=<unix seconds>,v1=<hex digest>`. Rejects a timestamp outside the tolerance
 * window, so a captured request cannot be replayed later. The digest comparison
 * is constant-time.
 *
 * Returns false for a missing, malformed, stale or non-matching signature.
 *
 * @throws {TypeError} when `payload` is not the raw body or `secret` is empty.
 */
export function verifyWebhookSignature(options: VerifyWebhookSignatureOptions): boolean {
  const { payload, signature, secret } = options;
  if (typeof payload !== "string" && !(payload instanceof Uint8Array)) {
    throw new TypeError(
      "verifyWebhookSignature: payload must be the raw request body (string or bytes), not a parsed object",
    );
  }
  if (!secret) throw new TypeError("verifyWebhookSignature: secret is required");

  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds <= 0) {
    throw new TypeError("verifyWebhookSignature: toleranceSeconds must be a positive number");
  }

  const parsed = parseSignatureHeader(signature);
  if (!parsed) return false;

  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / MS_PER_SECOND);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.`)
    .update(payload)
    .digest();

  return parsed.digests.some((digest) => timingSafeEqual(Buffer.from(digest, "hex"), expected));
}

interface ParsedSignature {
  timestamp: number;
  /** Every well-formed `v1` digest in the header, lowercase hex. */
  digests: string[];
}

function parseSignatureHeader(header: string | null | undefined): ParsedSignature | null {
  if (!header) return null;
  let timestamp: number | null = null;
  const digests: string[] = [];

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && TIMESTAMP_PATTERN.test(value)) {
      timestamp = Number(value);
    } else if (key === SIGNATURE_SCHEME && value.length === SHA256_HEX_LENGTH && HEX_PATTERN.test(value)) {
      digests.push(value.toLowerCase());
    }
  }

  if (timestamp === null || digests.length === 0) return null;
  return { timestamp, digests };
}

/** A record as stored at the moment of the event: the database row, keys in snake_case. */
export type WebhookSnapshot = Record<string, unknown>;

export interface WebhookFieldChange {
  old: unknown;
  new: unknown;
}

export interface WebhookTranscriptMessage {
  author: "client" | "ai" | "agent";
  text: string;
  created_at: string;
}

/** A create, update or delete of a CRM record. */
export interface WebhookEntityEvent {
  /** The record type, e.g. `LEAD`, `DEAL`, `CONTACT`, `PROJECT`, `UNIT`. */
  entityType: string;
  eventType: "CREATE" | "UPDATE" | "DELETE";
  entityId: number;
  /** The record before the change; null when there was none (a create). */
  before: WebhookSnapshot | null;
  /** The record after the change; null when there is none (a delete). */
  after: WebhookSnapshot | null;
  /** Field-level diff of `before` and `after`; null when either is missing or nothing changed. */
  changes: Record<string, WebhookFieldChange> | null;
  /** The lead's written conversation, attached to some lead updates. */
  messages?: WebhookTranscriptMessage[];
}

/** Sent by the Test button on a webhook in the CRM. */
export interface WebhookTestEvent {
  entityType: string;
  eventType: "TEST";
  entityId: number;
  test: true;
  message: string;
  timestamp: string;
  webhook_id: number;
  webhook_name: string;
}

export type WebhookEvent = WebhookEntityEvent | WebhookTestEvent;

const ENTITY_EVENT_TYPES: ReadonlySet<string> = new Set(["CREATE", "UPDATE", "DELETE"]);
const TEST_EVENT_TYPE = "TEST";

/**
 * Parses a webhook delivery body into a typed event, checking the envelope.
 * Verify the signature first: parsing proves the shape, not the sender.
 *
 * @throws {WebhookPayloadError} when the body is not JSON or not a QubeHub webhook event.
 */
export function parseWebhookEvent(payload: string | Uint8Array): WebhookEvent {
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new WebhookPayloadError(
      `Webhook body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(value)) throw new WebhookPayloadError("Webhook body must be a JSON object");
  const { entityType, eventType, entityId } = value;
  if (typeof entityType !== "string") throw new WebhookPayloadError("Webhook body has no string entityType");
  if (typeof entityId !== "number") throw new WebhookPayloadError("Webhook body has no numeric entityId");

  if (eventType === TEST_EVENT_TYPE) {
    if (value.test !== true) throw new WebhookPayloadError("A TEST event must carry test: true");
    return value as unknown as WebhookTestEvent;
  }
  if (typeof eventType !== "string" || !ENTITY_EVENT_TYPES.has(eventType)) {
    throw new WebhookPayloadError(`Unknown webhook eventType: ${JSON.stringify(eventType)}`);
  }

  for (const field of ["before", "after", "changes"] as const) {
    if (value[field] !== null && !isRecord(value[field])) {
      throw new WebhookPayloadError(`Webhook field ${field} must be an object or null`);
    }
  }
  if (value.messages !== undefined && !Array.isArray(value.messages)) {
    throw new WebhookPayloadError("Webhook field messages must be an array when present");
  }
  return value as unknown as WebhookEntityEvent;
}
