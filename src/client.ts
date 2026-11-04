import { QubeHubApiError } from "./errors.js";
import { isRecord } from "./guards.js";
import type {
  DataEnvelope,
  Lead,
  LeadGetParams,
  LeadListItem,
  LeadListParams,
  Page,
  Project,
  ProjectListItem,
  ProjectListParams,
  UnitDetail,
  UnitListItem,
  UnitListParams,
  Whoami,
} from "./types.js";

/** Every operation of the Partner Data API v1 lives under this path on the tenant's host. */
export const DATA_API_BASE_PATH = "/api/data/v1";

/** The request header that carries the API key. */
export const API_KEY_HEADER = "X-Internal-Key";

/** Hosts that may be reached over plain HTTP, for local development: the key never leaves the machine. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface QubeHubClientOptions {
  /**
   * Your tenant's host, the one you open the CRM on: `acme.qubehub.ai` or
   * `https://acme.qubehub.ai`. A bare host is reached over HTTPS. Plain `http://` is
   * accepted only for a loopback host (`localhost`, `127.0.0.1`, `[::1]`).
   */
  host: string;
  /** An API key issued by a tenant administrator in the CRM. Keep it server-side. */
  apiKey: string;
  /** A `fetch` implementation; defaults to the global one. */
  fetch?: FetchLike;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH";

export type QueryValue = string | number | boolean | Date | undefined;

export interface RequestOptions {
  query?: Readonly<Record<string, QueryValue>>;
  /** Serialized as JSON. */
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * A client for the QubeHub Partner Data API v1.
 *
 * The resource helpers cover the common reads; `request()` reaches any other
 * operation listed in your tenant's OpenAPI document.
 */
export class QubeHubClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  readonly projects = {
    list: (params: ProjectListParams = {}): Promise<Page<ProjectListItem>> =>
      this.request<Page<ProjectListItem>>("GET", "/projects", { query: { ...params } }),
    listAll: (params: Omit<ProjectListParams, "page"> = {}): AsyncGenerator<ProjectListItem> =>
      this.paginate<ProjectListItem>("/projects", { ...params }),
    get: async (id: number): Promise<Project> =>
      (await this.request<DataEnvelope<Project>>("GET", `/projects/${encodeId(id)}`)).data,
    /** Needs a key bound to an integration; otherwise the API responds 422 `INTEGRATION_REQUIRED`. */
    getByExternalId: async (externalId: string): Promise<Project> =>
      (await this.request<DataEnvelope<Project>>("GET", `/projects/by-external-id/${encodeURIComponent(externalId)}`)).data,
  };

  readonly units = {
    list: (params: UnitListParams = {}): Promise<Page<UnitListItem>> =>
      this.request<Page<UnitListItem>>("GET", "/units", { query: { ...params } }),
    listAll: (params: Omit<UnitListParams, "page"> = {}): AsyncGenerator<UnitListItem> =>
      this.paginate<UnitListItem>("/units", { ...params }),
    get: async (id: number): Promise<UnitDetail> =>
      (await this.request<DataEnvelope<UnitDetail>>("GET", `/units/${encodeId(id)}`)).data,
    /** Needs a key bound to an integration; otherwise the API responds 422 `INTEGRATION_REQUIRED`. */
    getByExternalId: async (externalId: string): Promise<UnitDetail> =>
      (await this.request<DataEnvelope<UnitDetail>>("GET", `/units/by-external-id/${encodeURIComponent(externalId)}`)).data,
  };

  readonly leads = {
    list: (params: LeadListParams = {}): Promise<Page<LeadListItem>> =>
      this.request<Page<LeadListItem>>("GET", "/leads", { query: { ...params } }),
    listAll: (params: Omit<LeadListParams, "page"> = {}): AsyncGenerator<LeadListItem> =>
      this.paginate<LeadListItem>("/leads", { ...params }),
    get: async (id: number, params: LeadGetParams = {}): Promise<Lead> =>
      (await this.request<DataEnvelope<Lead>>("GET", `/leads/${encodeId(id)}`, { query: { ...params } })).data,
  };

  constructor(options: QubeHubClientOptions) {
    if (!options.apiKey) throw new TypeError("QubeHubClient: apiKey is required");
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError("QubeHubClient: no global fetch is available; pass one in options.fetch");
    }
    this.baseUrl = `${resolveOrigin(options.host)}${DATA_API_BASE_PATH}`;
    this.apiKey = options.apiKey;
    // Called detached from the client: a browser's fetch throws when invoked as a method of another object.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

  /** The key's identity, scopes, integration and rate limit: the first call to make with a new key. */
  async whoami(): Promise<Whoami> {
    return (await this.request<DataEnvelope<Whoami>>("GET", "/whoami")).data;
  }

  /**
   * Calls any operation of the API. `path` is relative to `/api/data/v1`, e.g. `/deals`.
   * The response body is returned as `T` without runtime validation.
   *
   * Redirects are never followed, so the API key is only ever sent to the configured host.
   *
   * @throws {QubeHubApiError} on a non-2xx status (a redirect included) or a 2xx body that is not JSON.
   */
  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) throw new TypeError(`QubeHubClient: path must start with "/", got "${path}"`);

    const url = `${this.baseUrl}${path}${toQueryString(options.query)}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      [API_KEY_HEADER]: this.apiKey,
    };
    // fetch keeps custom headers on a cross-origin redirect, so following one could hand the key to another host.
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    if (options.signal) init.signal = options.signal;

    const response = await this.fetchImpl(url, init);
    if (isRedirect(response)) {
      throw new QubeHubApiError({
        status: response.status,
        message: `${method} ${path} was redirected; the client does not follow redirects, so check the configured host`,
        errorCode: null,
        details: undefined,
        retryAfterSeconds: null,
      });
    }
    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) throw toApiError(response, parsed);
    if (!parsed.ok) {
      throw new QubeHubApiError({
        status: response.status,
        message: `Expected a JSON response from ${method} ${path}`,
        errorCode: null,
        details: undefined,
        retryAfterSeconds: null,
      });
    }
    return parsed.value as T;
  }

  /**
   * Iterates every row of a list endpoint, requesting page after page until the
   * `pagination.total` the server reports is covered.
   *
   * Lists are ordered by most recent update, so a record updated while you iterate
   * can move between pages. For a complete sync, note the time before you start and
   * pass it as `updatedSince` on the next run.
   */
  async *paginate<T>(path: string, query: Readonly<Record<string, QueryValue>> = {}): AsyncGenerator<T> {
    let page = 1;
    for (;;) {
      const result = await this.request<Page<T>>("GET", path, { query: { ...query, page } });
      if (!Array.isArray(result.data) || !isRecord(result.pagination)) {
        throw new TypeError(`QubeHubClient: ${path} did not return a paginated list`);
      }
      yield* result.data;
      const { pagination } = result;
      if (result.data.length === 0 || pagination.page * pagination.limit >= pagination.total) return;
      page = pagination.page + 1;
    }
  }
}

function resolveOrigin(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) throw new TypeError("QubeHubClient: host is required");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new TypeError(`QubeHubClient: "${host}" is not a valid host`);
  }
  const isLoopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new TypeError(
      `QubeHubClient: host must use https (plain http is accepted only for localhost), got "${url.protocol}//${url.host}"`,
    );
  }
  return url.origin;
}

/** A browser reports a manual redirect as an opaque response with status 0; Node keeps the 3xx status. */
function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

function encodeId(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError(`QubeHubClient: invalid id ${id}`);
  return String(id);
}

function toQueryString(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(name, serializeQueryValue(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function serializeQueryValue(value: Exclude<QueryValue, undefined>): string {
  if (!(value instanceof Date)) return String(value);
  if (Number.isNaN(value.getTime())) throw new TypeError("QubeHubClient: invalid Date in query");
  return value.toISOString();
}

type ParsedBody = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string): ParsedBody {
  if (!text) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function toApiError(response: Response, parsed: ParsedBody): QubeHubApiError {
  const envelope = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  const message = typeof envelope?.message === "string" && envelope.message
    ? envelope.message
    : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  return new QubeHubApiError({
    status: response.status,
    message,
    errorCode: typeof envelope?.error_code === "string" ? envelope.error_code : null,
    details: envelope?.details,
    retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
  });
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}
