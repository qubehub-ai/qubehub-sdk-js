import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { QubeHubApiError, QubeHubClient, type FetchLike } from "../src/index.js";

interface RecordedCall {
  url: URL;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A fetch double that responds to each call through `respond` and records what was sent. */
function mockFetch(respond: (url: URL, call: number) => Response): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    return respond(url, calls.length);
  };
  return { fetch, calls };
}

function headerOf(call: RecordedCall | undefined, name: string): string | undefined {
  const headers = call?.init.headers as Record<string, string> | undefined;
  return headers?.[name];
}

describe("QubeHubClient requests", () => {
  it("sends the key header to the tenant's Data API and unwraps the data envelope", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse(200, {
        data: {
          key: { id: 1, name: "ERP sync", prefix: "test_ab12", scopes: ["units:read"], expiresAt: null, createdAt: "2026-11-01T00:00:00.000Z" },
          integration: null,
          tenant: { host: "acme.qubehub.ai", baseUrl: "https://acme.qubehub.ai/api/data/v1" },
          rateLimit: { requestsPerMinute: 600, authFailuresPerMinute: 30 },
          openApiUrl: "https://acme.qubehub.ai/data-api-docs/swagger.json",
        },
      }),
    );
    const client = new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "test-api-key", fetch });

    const whoami = await client.whoami();

    expect(whoami.key.scopes).toEqual(["units:read"]);
    expect(calls[0]?.url.href).toBe("https://acme.qubehub.ai/api/data/v1/whoami");
    expect(calls[0]?.init.method).toBe("GET");
    expect(headerOf(calls[0], "X-Internal-Key")).toBe("test-api-key");
  });

  it("accepts a host given as an origin and serializes query parameters", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { data: [], pagination: { page: 2, limit: 50, total: 0 } }));
    const client = new QubeHubClient({ host: "https://acme.qubehub.ai/", apiKey: "k", fetch });

    await client.units.list({
      page: 2,
      limit: 50,
      projectId: 9,
      includeMedia: true,
      hasExternalId: false,
      updatedSince: new Date("2026-11-01T00:00:00Z"),
      externalId: undefined,
    });

    const url = calls[0]?.url;
    expect(url?.origin + (url?.pathname ?? "")).toBe("https://acme.qubehub.ai/api/data/v1/units");
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      page: "2",
      limit: "50",
      projectId: "9",
      includeMedia: "true",
      hasExternalId: "false",
      updatedSince: "2026-11-01T00:00:00.000Z",
    });
  });

  it("escapes an external identifier in the path", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { data: { id: 5 } }));
    const client = new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "k", fetch });

    await client.units.getByExternalId("A/101 #2");

    expect(calls[0]?.url.pathname).toBe("/api/data/v1/units/by-external-id/A%2F101%20%232");
  });

  it("sends a JSON body through request()", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { data: { id: 5 } }));
    const client = new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "k", fetch });

    await client.request("PATCH", "/units/5", { body: { startPrice: 250000 } });

    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.init.body).toBe('{"startPrice":250000}');
    expect(headerOf(calls[0], "Content-Type")).toBe("application/json");
  });

  it("refuses invalid configuration and ids before any request", async () => {
    expect(() => new QubeHubClient({ host: "", apiKey: "k" })).toThrow(TypeError);
    expect(() => new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "" })).toThrow(TypeError);
    expect(() => new QubeHubClient({ host: "ftp://acme.qubehub.ai", apiKey: "k" })).toThrow(TypeError);
    const { fetch, calls } = mockFetch(() => jsonResponse(200, {}));
    const client = new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "k", fetch });
    await expect(client.units.get(0)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("QubeHubClient transport security", () => {
  it("refuses plain http to any host but a loopback one", () => {
    expect(() => new QubeHubClient({ host: "http://acme.qubehub.ai", apiKey: "k" })).toThrow(/must use https/);
    for (const host of ["http://localhost:6000", "http://127.0.0.1:6000", "http://[::1]:6000"]) {
      expect(new QubeHubClient({ host, apiKey: "k" }).baseUrl).toBe(`${host}/api/data/v1`);
    }
  });

  it("asks fetch not to follow redirects and refuses a 3xx without a second request", async () => {
    const { fetch, calls } = mockFetch(() =>
      new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/api/data/v1/whoami" } }),
    );
    const client = new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "k", fetch });

    const error = await client.whoami().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QubeHubApiError);
    expect((error as QubeHubApiError).status).toBe(302);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("never sends the key to the origin of a cross-origin redirect", async () => {
    const received: IncomingHttpHeaders[] = [];
    const target = await listen(createServer((req, res) => {
      received.push(req.headers);
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    }));
    const redirecting = await listen(createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${portOf(target)}/stolen` }).end();
    }));
    try {
      const client = new QubeHubClient({ host: `http://127.0.0.1:${portOf(redirecting)}`, apiKey: "secret-key" });
      await expect(client.whoami()).rejects.toBeInstanceOf(QubeHubApiError);
      expect(received).toHaveLength(0);
    } finally {
      target.close();
      redirecting.close();
    }
  });
});

async function listen(server: Server): Promise<Server> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP server");
  return address.port;
}

describe("QubeHubApiError", () => {
  async function failureOf(response: Response): Promise<QubeHubApiError> {
    const client = new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "k", fetch: mockFetch(() => response).fetch });
    const error = await client.projects.list().catch((caught: unknown) => caught);
    if (!(error instanceof QubeHubApiError)) throw new Error("expected a QubeHubApiError");
    return error;
  }

  it("carries status, error_code, message and details from the envelope", async () => {
    const error = await failureOf(
      jsonResponse(403, {
        code: 403,
        message: 'This key does not hold the scope "projects:read" the operation requires',
        error_code: "INSUFFICIENT_SCOPE",
        details: { requiredScope: "projects:read", requiredScopes: ["projects:read"], grantedScopes: ["units:read"] },
      }),
    );
    expect(error.status).toBe(403);
    expect(error.errorCode).toBe("INSUFFICIENT_SCOPE");
    expect(error.message).toContain("projects:read");
    expect(error.details).toEqual({ requiredScope: "projects:read", requiredScopes: ["projects:read"], grantedScopes: ["units:read"] });
    expect(error.retryAfterSeconds).toBeNull();
  });

  it("reads an envelope without details or error_code", async () => {
    const error = await failureOf(jsonResponse(404, { code: 404, message: "Project 9 not found" }));
    expect(error.status).toBe(404);
    expect(error.errorCode).toBeNull();
    expect(error.details).toBeUndefined();
    expect(error.message).toBe("Project 9 not found");
  });

  it("exposes Retry-After on a rate-limited response", async () => {
    const error = await failureOf(
      jsonResponse(429, { code: 429, message: "Too many requests", error_code: "RATE_LIMITED" }, { "Retry-After": "12" }),
    );
    expect(error.errorCode).toBe("RATE_LIMITED");
    expect(error.retryAfterSeconds).toBe(12);
  });

  it("falls back to the HTTP status when the body is not JSON", async () => {
    const error = await failureOf(new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    expect(error.status).toBe(502);
    expect(error.errorCode).toBeNull();
    expect(error.message).toBe("HTTP 502 Bad Gateway");
  });

  it("refuses a successful response whose body is not JSON", async () => {
    const error = await failureOf(new Response("ok", { status: 200 }));
    expect(error.status).toBe(200);
    expect(error.message).toContain("Expected a JSON response");
  });
});

describe("pagination", () => {
  const TOTAL = 5;
  const rows = Array.from({ length: TOTAL }, (_, index) => ({ id: index + 1, name: `Unit ${index + 1}` }));

  function pagedFetch(serverLimit: number) {
    return mockFetch((url) => {
      const page = Number(url.searchParams.get("page"));
      const start = (page - 1) * serverLimit;
      return jsonResponse(200, {
        data: rows.slice(start, start + serverLimit),
        pagination: { page, limit: serverLimit, total: TOTAL },
      });
    });
  }

  it("walks every page until the reported total is covered", async () => {
    const { fetch, calls } = pagedFetch(2);
    const client = new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "k", fetch });

    const seen: number[] = [];
    for await (const unit of client.units.listAll({ limit: 2, projectId: 3 })) seen.push(unit.id);

    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(calls.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(calls.every((call) => call.url.searchParams.get("projectId") === "3")).toBe(true);
  });

  it("follows the page size the server applied, not the one requested", async () => {
    const { fetch, calls } = pagedFetch(5);
    const client = new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "k", fetch });

    const seen: number[] = [];
    for await (const unit of client.units.listAll({ limit: 1000 })) seen.push(unit.id);

    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toHaveLength(1);
  });

  it("stops on an empty page even if the total says otherwise", async () => {
    const { fetch, calls } = mockFetch((url) =>
      jsonResponse(200, {
        data: url.searchParams.get("page") === "1" ? [{ id: 1 }] : [],
        pagination: { page: Number(url.searchParams.get("page")), limit: 1, total: 10 },
      }),
    );
    const client = new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "k", fetch });

    const seen: number[] = [];
    for await (const lead of client.leads.listAll()) seen.push(lead.id);

    expect(seen).toEqual([1]);
    expect(calls).toHaveLength(2);
  });

  it("refuses to paginate an operation that is not a list", async () => {
    const { fetch } = mockFetch(() => jsonResponse(200, { data: { id: 1 } }));
    const client = new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "k", fetch });

    await expect(async () => {
      for await (const _row of client.paginate("/whoami")) break;
    }).rejects.toThrow(TypeError);
  });

  it("propagates an error from a later page", async () => {
    const { fetch } = mockFetch((_url, call) =>
      call === 1
        ? jsonResponse(200, { data: [{ id: 1 }], pagination: { page: 1, limit: 1, total: 2 } })
        : jsonResponse(429, { code: 429, message: "Too many requests", error_code: "RATE_LIMITED" }),
    );
    const client = new QubeHubClient({ host: "acme.qubehub.ai", apiKey: "k", fetch });

    const seen: number[] = [];
    await expect(async () => {
      for await (const project of client.projects.listAll()) seen.push(project.id);
    }).rejects.toBeInstanceOf(QubeHubApiError);
    expect(seen).toEqual([1]);
  });
});
