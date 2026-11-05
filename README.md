# qubehub: the TypeScript SDK for QubeHub

QubeHub is the sales platform for real estate developers: a real estate CRM, live inventory on a unit matrix (the chessboard), a broker and agent portal and one inbox for buyer messages, all working from one live record per unit. This package is the official TypeScript SDK for the QubeHub **Partner Data API v1** and for verifying **QubeHub webhooks**, so your ERP, website and BI tools use the same live inventory, leads and deals as your sales team.

## Why developers run their sales on QubeHub

Many developers still sell from scattered sources: an inventory spreadsheet, a PDF price list sent around in chats, floor plans in a shared drive and offers assembled by hand. A unit sold on Saturday is still on Monday's price list, brokers get different versions of the portfolio, and agents call to ask what's available. QubeHub replaces that with one live record per unit. Change a price or sell a unit once, and the agent portal and project pages show it, and every new price list and offer is generated from it.

- **Inventory and prices.** The chessboard shows every unit with its floor, type, area, status and price, and every price change records who made it, when and by how much.
- **Buyers and deals.** Direct leads, agent leads and rental inquiries run in separate funnels, with a duplicate check on every new buyer.
- **One inbox.** WhatsApp, Telegram and email in one place, with an AI assistant that replies in seconds and hands qualified buyers to your team.
- **Broker channel.** A branded agent portal where each agent or agency sees only what you share, and agents keep the buyers they register.

Every module: [qubehub.ai/platform](https://qubehub.ai/platform). How developers run on QubeHub: [qubehub.ai/#cases](https://qubehub.ai/#cases).

QubeHub is built for property developers selling condos, townhomes, single-family homes or master-planned communities, including pre-construction (off-plan) projects, in the US, Europe, the Middle East and Asia. Company owners and executives set prices and terms, sales managers and heads of sales run leads and deals, marketers launch pages from live inventory, and outside brokers sell from the same data.

**Want to see it on your own projects? Book a demo at [qubehub.ai](https://qubehub.ai).**

## What you can build with this SDK

- **Catalog sync from your ERP.** Keep projects, units, prices and sale status in QubeHub in sync with your ERP or inventory system, addressed by your own external IDs. The typed helpers cover the reads; writes such as `PUT /units/by-external-id/{externalId}` go through `request()` with a key that holds `units:write` and is bound to an integration (see the [Partner Data API guide](https://github.com/qubehub-ai/qubehub-docs/blob/main/docs/data-api.md)).
- **A live availability feed for your website.** Pull every unit with its status and price into your own site or a listings feed, then refresh only what changed with `updatedSince`. If you'd rather not build the UI, [qubehub-widgets](https://github.com/qubehub-ai/qubehub-widgets) embeds the live chessboard itself.
- **CRM events into your BI pipeline.** Subscribe to lead, deal, contact, unit or project changes, receive a `POST` for each one, verify its signature with one function call (set a signing secret on the webhook) and load it into your warehouse or reporting tool.
- **Lead exports for reporting.** Page through leads with `leads.listAll()` and feed them into the dashboards your head of sales already reads.

What the package gives you:

- Zero runtime dependencies. ESM. Node.js 18 or later (uses the global `fetch`).
- Typed resource helpers for the common reads, a generic `request()` for everything else.
- An async iterator that walks paginated lists for you.
- Constant-time webhook signature verification with replay protection.

## Install

```sh
npm install qubehub
```

## Quick start

A tenant administrator issues an API key in the QubeHub CRM (**Settings → API Keys**) and picks its scopes, such as `projects:read` or `units:read`. The key is shown once; keep it in a secret store and use it only on a server.

```ts
import { QubeHubClient } from "qubehub";

const qubehub = new QubeHubClient({
  host: "acme.qubehub.ai", // the host you open the CRM on; always reached over HTTPS
  apiKey: process.env.QUBEHUB_API_KEY!,
});

// Check the key: its scopes, its integration and where the API reference lives.
const me = await qubehub.whoami();
console.log(me.key.scopes, me.openApiUrl);

// One page of units of a project.
const page = await qubehub.units.list({ projectId: 12, limit: 100 });
console.log(page.pagination.total);

// Every unit, page after page.
for await (const unit of qubehub.units.listAll({ projectId: 12 })) {
  console.log(unit.unitNumber, unit.saleType, unit.startPrice, unit.currency);
}
```

## What the client covers

| Helper | Operation | Scope |
|---|---|---|
| `whoami()` | `GET /api/data/v1/whoami` | any valid key |
| `projects.list()`, `projects.listAll()` | `GET /api/data/v1/projects` | `projects:read` |
| `projects.get(id)`, `projects.getByExternalId(externalId)`¹ | `GET /api/data/v1/projects/{id}`, `…/projects/by-external-id/{externalId}` | `projects:read` |
| `units.list()`, `units.listAll()` | `GET /api/data/v1/units` | `units:read` |
| `units.get(id)`, `units.getByExternalId(externalId)`¹ | `GET /api/data/v1/units/{id}`, `…/units/by-external-id/{externalId}` | `units:read` |
| `leads.list()`, `leads.listAll()` | `GET /api/data/v1/leads` | `leads:read` |
| `leads.get(id)` | `GET /api/data/v1/leads/{id}` | `leads:read` |

¹ Addressing records by your own identifier (`getByExternalId()`, and the `externalId` and `hasExternalId` list filters) needs a key bound to an integration.

The response types name the fields the SDK relies on; every record carries more, reachable as `unknown` through an index signature. For any other operation, call `request()` with a path relative to `/api/data/v1`:

```ts
const deals = await qubehub.request<{ data: Array<{ id: number }> }>("GET", "/deals", {
  query: { page: 1, limit: 50 },
});
```

The full, machine-readable reference is the OpenAPI document your tenant serves at `https://{your-tenant-host}/data-api-docs/swagger.json` (also returned as `openApiUrl` by `whoami()`).

### Pagination

List endpoints return `{ data, pagination: { page, limit, total } }`. Pages are 1-based; the server defaults `limit` to 100 and caps it at 500. `listAll()` and the generic `paginate(path, query)` request page after page until `total` is covered.

Lists are ordered by most recent update, so a record that changes while you iterate can move between pages. For a complete incremental sync, note the time before you start and pass it as `updatedSince` on the next run.

### Errors

Every non-2xx response (and a 2xx body that is not JSON) throws a `QubeHubApiError` built from the API's error envelope `{ code, message, error_code, details }`. Network errors and aborts propagate from `fetch` unchanged.

```ts
import { QubeHubApiError } from "qubehub";

try {
  await qubehub.projects.list();
} catch (error) {
  if (error instanceof QubeHubApiError && error.errorCode === "INSUFFICIENT_SCOPE") {
    console.error("The key needs another scope:", error.details);
  } else {
    throw error;
  }
}
```

| `status` | `errorCode` | Meaning |
|---|---|---|
| 400 | none | A query value is invalid, such as an `updatedSince` that is not an ISO 8601 date or a `projectId` below 1. |
| 401 | `UNAUTHENTICATED` | The key is missing, unknown, disabled, revoked or expired. |
| 403 | `INSUFFICIENT_SCOPE` | The key lacks the operation's scope; `details` names the required and granted scopes. |
| 422 | `VALIDATION_FAILED` | The request has the wrong shape; `details` names the fields. |
| 422 | `INTEGRATION_REQUIRED` | The key is not bound to an integration, so it cannot address records by `externalId`. |
| 429 | `RATE_LIMITED` | Too many requests, either for this key or too many failed authentications from one IP address; `whoami().rateLimit` reports both limits. |

Branch on `errorCode`, never on `message`: codes are stable, messages may change. `errorCode` is `null` when a response carries no code (for example, some `404` responses). `retryAfterSeconds` is set when the server sends a `Retry-After` header.

## Webhooks

QubeHub sends a `POST` with a JSON body to your endpoint each time a subscribed record (a lead, deal, contact, unit, project and more) is created, updated or deleted. Webhooks and their subscriptions are configured in the CRM (**Settings → Webhooks**). When the webhook has a signing secret, each delivery carries `X-Signature-256: t=<unix seconds>,v1=<hex>`, an HMAC-SHA256 of `"<t>.<raw body>"` keyed with that secret.

Verify the signature against the **raw** body, before parsing it: re-serialized JSON does not match.

```ts
import express from "express";
import { WEBHOOK_HEADERS, parseWebhookEvent, verifyWebhookSignature } from "qubehub";

const app = express();

app.post("/webhooks/qubehub", express.raw({ type: "application/json" }), (req, res) => {
  const valid = verifyWebhookSignature({
    payload: req.body, // a Buffer, thanks to express.raw()
    signature: req.get(WEBHOOK_HEADERS.signature),
    secret: process.env.QUBEHUB_WEBHOOK_SECRET!,
  });
  if (!valid) {
    res.status(401).send("invalid signature");
    return;
  }

  const deliveryId = req.get(WEBHOOK_HEADERS.deliveryId); // the same on every retry: deduplicate on it
  const event = parseWebhookEvent(req.body);

  if (event.eventType === "TEST") {
    console.log("Test delivery from webhook", event.webhook_name);
  } else if (event.entityType === "LEAD" && event.eventType === "UPDATE") {
    console.log(deliveryId, "lead", event.entityId, "changed:", Object.keys(event.changes ?? {}));
  }

  res.sendStatus(200);
});
```

What to know about deliveries:

- The body is `{ entityType, eventType, entityId, before, after, changes }`. `eventType` is `CREATE`, `UPDATE` or `DELETE`; `before` and `after` are snapshots of the record; `changes` maps each changed field to `{ old, new }`. Some lead updates also carry the written conversation as `messages`. The Test button in the CRM sends `eventType: "TEST"`.
- Headers: `X-Webhook-Id`, `X-Delivery-Id`, `X-Event-Type`, `X-Entity-Type`, and the signature headers when a secret is set. `WEBHOOK_HEADERS` exports the names.
- Respond with a `2xx` status within 15 seconds. Anything else, a timeout or a network error is retried a limited number of times on an increasing delay over about a day and a half, with the same `X-Delivery-Id`, so make your handler idempotent. After the last attempt the delivery is marked failed; failed deliveries can be re-sent from the CRM. A test delivery is sent once, with no automatic retry.
- `verifyWebhookSignature` rejects a timestamp more than 300 seconds from your clock (set `toleranceSeconds` to change it) and compares digests in constant time. QubeHub also sends a legacy `X-Signature` header (an HMAC of the body alone, without a timestamp); prefer `X-Signature-256`.

## FAQ

**What is QubeHub?**
QubeHub is the sales platform for real estate developers. It brings inventory and prices, buyers and deals, buyer messaging, a broker portal, marketing pages and a showroom of aerial tours, clickable master plans and 360° spins into one hub, where one live record for every unit feeds every price list, offer, portal and project page.

**Does QubeHub have an API?**
Yes. QubeHub has a Partner Data API that reads and writes projects, units, building structure and media, and reads leads, deals, agents and rental inquiries. Signed webhooks report record changes. Each API key holds only the scopes an admin picks, and the `qubehub` npm package is the official TypeScript SDK for it.

**Can I sync units and prices from my ERP into QubeHub?**
Yes. The QubeHub Partner Data API addresses projects and units by your own external IDs, so an ERP or inventory system can create and update units, prices and sale status in QubeHub. The `qubehub` TypeScript SDK wraps the reads, and its `request()` method calls the write endpoints.

**Can I show live unit availability on my own website?**
Yes. Pull units with their status and price through the QubeHub Partner Data API, refreshing only what changed since the last sync, or embed the live chessboard with QubeHub's embeddable widgets, from two lines of HTML.

**Do I have to replace my CRM, website or ERP to use QubeHub?**
No. QubeHub runs on top of what you already use, or on its own. Your website, ERP and BI tools connect through the Partner Data API, signed webhooks and embeddable widgets.

**Where is my data stored?**
Each QubeHub customer runs on its own database instance, hosted in the EU (Germany) and encrypted in transit and at rest. An API key works only against the workspace that issued it, and a webhook sends only that workspace's events. QubeHub never uses customer data to train AI models.

**How long does it take to go live?**
QubeHub onboarding typically takes 1–14 days, depending on the portfolio. With your data ready, the first project goes live on day one, and your current systems keep running in the meantime. Custom integrations are scoped separately.

**How can I see QubeHub on my own projects?**
Book a demo at [qubehub.ai](https://qubehub.ai). The QubeHub team walks you through the platform using your own projects and units. Developers who already have a workspace can go straight to the [Quick start](#quick-start).

## More from QubeHub

- [qubehub-docs](https://github.com/qubehub-ai/qubehub-docs): developer documentation for the Partner Data API, webhooks, automations, embeddable widgets and AI assistants.
- [qubehub-mcp](https://github.com/qubehub-ai/qubehub-mcp): connect Claude, Claude Code or another MCP client to your QubeHub leads, deals and live units, under your own CRM role and permissions.
- [qubehub-widgets](https://github.com/qubehub-ai/qubehub-widgets): embed a live unit picker (chessboard) on a developer's website.
- [qubehub.ai/platform](https://qubehub.ai/platform): every QubeHub module.
- [qubehub.ai/security](https://qubehub.ai/security): how QubeHub protects your data.
- [qubehub.ai](https://qubehub.ai): the product, and **Book a demo**.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

The package runs on Node.js 18 or later; the test toolchain needs Node.js 20 or later.

## Security

Please report vulnerabilities privately to [legal@qubehub.ai](mailto:legal@qubehub.ai) with the subject "Security report". Do not open a public issue.

## License

[MIT](LICENSE) © 2026 WEDO4U LTD, trading as QubeHub.
