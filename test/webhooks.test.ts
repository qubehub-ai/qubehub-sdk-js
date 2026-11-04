import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  WebhookPayloadError,
  parseWebhookEvent,
  verifyWebhookSignature,
} from "../src/index.js";

const SECRET = "whsec_test_secret";
const NOW = new Date("2026-11-05T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

/** Signs a delivery the way the QubeHub server does: JSON body, `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
function signLikeServer(payload: unknown, secret: string, timestampSeconds: number): { body: string; header: string } {
  const body = JSON.stringify(payload);
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return { body, header: `t=${timestampSeconds},v1=${digest}` };
}

const LEAD_UPDATE = {
  entityType: "LEAD",
  eventType: "UPDATE",
  entityId: 42,
  before: { id: 42, lead_status_id: 1, name: "Zoë Müller" },
  after: { id: 42, lead_status_id: 2, name: "Zoë Müller" },
  changes: { lead_status_id: { old: 1, new: 2 } },
  messages: [{ author: "client", text: "Is the 2-bedroom still available?", created_at: "2026-11-05T11:58:00.000Z" }],
};

describe("verifyWebhookSignature", () => {
  it("accepts a delivery signed the way the server signs it", () => {
    const { body, header } = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS);
    expect(verifyWebhookSignature({ payload: body, signature: header, secret: SECRET, now: NOW })).toBe(true);
  });

  it("accepts the raw body as bytes, non-ASCII text included", () => {
    const { body, header } = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS);
    const bytes = new TextEncoder().encode(body);
    expect(verifyWebhookSignature({ payload: bytes, signature: header, secret: SECRET, now: NOW })).toBe(true);
    expect(verifyWebhookSignature({ payload: Buffer.from(body), signature: header, secret: SECRET, now: NOW })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { body, header } = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS);
    const tampered = body.replace('"entityId":42', '"entityId":43');
    expect(tampered).not.toBe(body);
    expect(verifyWebhookSignature({ payload: tampered, signature: header, secret: SECRET, now: NOW })).toBe(false);
  });

  it("rejects a re-serialized body even when the JSON is equivalent", () => {
    const { body, header } = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS);
    const reformatted = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyWebhookSignature({ payload: reformatted, signature: header, secret: SECRET, now: NOW })).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    const { body, header } = signLikeServer(LEAD_UPDATE, "another-secret", NOW_SECONDS);
    expect(verifyWebhookSignature({ payload: body, signature: header, secret: SECRET, now: NOW })).toBe(false);
  });

  it("rejects a timestamp swapped into a valid digest", () => {
    const { body, header } = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS);
    const swapped = header.replace(`t=${NOW_SECONDS}`, `t=${NOW_SECONDS - 1}`);
    expect(verifyWebhookSignature({ payload: body, signature: swapped, secret: SECRET, now: NOW })).toBe(false);
  });

  it("enforces the tolerance window in both directions", () => {
    const tolerance = DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
    const atEdge = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS - tolerance);
    const stale = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS - tolerance - 1);
    const future = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS + tolerance + 1);
    expect(verifyWebhookSignature({ payload: atEdge.body, signature: atEdge.header, secret: SECRET, now: NOW })).toBe(true);
    expect(verifyWebhookSignature({ payload: stale.body, signature: stale.header, secret: SECRET, now: NOW })).toBe(false);
    expect(verifyWebhookSignature({ payload: future.body, signature: future.header, secret: SECRET, now: NOW })).toBe(false);
    expect(
      verifyWebhookSignature({ payload: stale.body, signature: stale.header, secret: SECRET, now: NOW, toleranceSeconds: tolerance + 1 }),
    ).toBe(true);
  });

  it("returns false for a missing or malformed header", () => {
    const { body, header } = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS);
    const digest = header.split("v1=")[1] ?? "";
    for (const signature of [undefined, null, "", "garbage", `v1=${digest}`, `t=${NOW_SECONDS}`, `t=abc,v1=${digest}`, `t=${NOW_SECONDS},v1=zz`]) {
      expect(verifyWebhookSignature({ payload: body, signature, secret: SECRET, now: NOW })).toBe(false);
    }
  });

  it("accepts a header listing several v1 digests when one matches", () => {
    const { body, header } = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS);
    const withExtra = `${header},v1=${"0".repeat(64)}`;
    expect(verifyWebhookSignature({ payload: body, signature: withExtra, secret: SECRET, now: NOW })).toBe(true);
  });

  it("refuses a parsed object instead of the raw body", () => {
    const { header } = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS);
    const parsed: unknown = LEAD_UPDATE;
    expect(() =>
      verifyWebhookSignature({ payload: parsed as string, signature: header, secret: SECRET, now: NOW }),
    ).toThrow(TypeError);
  });

  it("refuses an empty secret", () => {
    const { body, header } = signLikeServer(LEAD_UPDATE, SECRET, NOW_SECONDS);
    expect(() => verifyWebhookSignature({ payload: body, signature: header, secret: "", now: NOW })).toThrow(TypeError);
  });
});

describe("parseWebhookEvent", () => {
  it("parses an entity event", () => {
    const event = parseWebhookEvent(JSON.stringify(LEAD_UPDATE));
    expect(event.eventType).toBe("UPDATE");
    if (event.eventType === "TEST") throw new Error("expected an entity event");
    expect(event.entityId).toBe(42);
    expect(event.changes?.lead_status_id).toEqual({ old: 1, new: 2 });
    expect(event.messages?.[0]?.author).toBe("client");
  });

  it("parses a create with no before snapshot and no diff", () => {
    const event = parseWebhookEvent(
      JSON.stringify({ entityType: "DEAL", eventType: "CREATE", entityId: 7, before: null, after: { id: 7 }, changes: null }),
    );
    expect(event.eventType).toBe("CREATE");
  });

  it("parses the test event the CRM sends", () => {
    const event = parseWebhookEvent(
      new TextEncoder().encode(
        JSON.stringify({
          entityType: "LEAD",
          eventType: "TEST",
          entityId: 0,
          message: "This is a test webhook",
          timestamp: "2026-11-05T12:00:00.000Z",
          test: true,
          webhook_id: 3,
          webhook_name: "ERP sync",
        }),
      ),
    );
    expect(event.eventType).toBe("TEST");
    if (event.eventType !== "TEST") throw new Error("expected a test event");
    expect(event.webhook_id).toBe(3);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["no entityType", JSON.stringify({ eventType: "CREATE", entityId: 1, before: null, after: {}, changes: null })],
    ["an unknown eventType", JSON.stringify({ entityType: "LEAD", eventType: "MERGE", entityId: 1, before: null, after: {}, changes: null })],
    ["a non-object snapshot", JSON.stringify({ entityType: "LEAD", eventType: "UPDATE", entityId: 1, before: "x", after: {}, changes: null })],
    ["messages that are not an array", JSON.stringify({ ...LEAD_UPDATE, messages: "hi" })],
  ])("rejects %s", (_label, body) => {
    expect(() => parseWebhookEvent(body)).toThrow(WebhookPayloadError);
  });
});
