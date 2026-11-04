/**
 * Response types for the Partner Data API v1.
 *
 * Each type names only the fields this SDK relies on; every record carries more.
 * The index signature keeps the rest reachable as `unknown`. The full field list
 * is in your tenant's OpenAPI document (`openApiUrl` from `whoami()`).
 */

/** The pagination block every list endpoint returns next to `data`. */
export interface Pagination {
  /** 1-based page number. */
  page: number;
  /** Page size the server applied (it clamps the requested `limit`). */
  limit: number;
  /** Rows matching the query across all pages. */
  total: number;
}

export interface Page<T> {
  data: T[];
  pagination: Pagination;
}

/** The single-record envelope: `{ "data": … }`. */
export interface DataEnvelope<T> {
  data: T;
}

export interface Whoami {
  key: {
    id: number;
    name: string;
    /** The first characters of the key, for recognition. */
    prefix: string;
    /** The scopes the key holds, write scopes already expanded to include their read scope. */
    scopes: string[];
    expiresAt: string | null;
    createdAt: string;
  };
  /** The integration whose external-identifier namespace this key writes into; null for a key without one. */
  integration: { id: number; slug: string; name: string } | null;
  tenant: { host: string; baseUrl: string };
  rateLimit: { requestsPerMinute: number; authFailuresPerMinute: number };
  /** URL of the tenant's OpenAPI document for this API. */
  openApiUrl: string;
}

/** Fields shared by a project in a list and a project read by id. */
export interface Project {
  id: number;
  name: string;
  /** The stored source identifier, verbatim, whichever integration wrote it. */
  originalId: string | null;
  /** Your own identifier, when the record is bound to one in your key's integration namespace. */
  externalId: string | null;
  stage: string;
  createdAt: string;
  updatedAt: string | null;
  [field: string]: unknown;
}

export interface ProjectListItem extends Project {
  unitCount: number;
}

/** Fields shared by a unit in a list and a unit read by id. */
export interface Unit {
  id: number;
  name: string;
  unitNumber: string;
  originalId: string | null;
  externalId: string | null;
  bedrooms: number;
  bathrooms: number;
  block: string | null;
  section: string | null;
  floor: number | null;
  /** Major units of `currency`. */
  startPrice: number;
  currency: string | null;
  saleType: string;
  createdAt: string;
  updatedAt: string | null;
  [field: string]: unknown;
}

export interface UnitListItem extends Unit {
  projectId: number;
  projectName: string;
}

export interface UnitDetail extends Unit {
  project: {
    id: number;
    name: string;
    stage: string;
    originalId: string | null;
    externalId: string | null;
    formattedAddress: string | null;
  };
}

/** Fields shared by a lead in a list and a lead read by id. */
export interface Lead {
  id: number;
  originalId: string | null;
  /**
   * The lead's id in the ad platform it arrived from; for a lead without an ad-intake record,
   * the stored source identifier (`originalId`), or null.
   */
  externalLeadId: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string | null;
  [field: string]: unknown;
}

export interface LeadListItem extends Lead {
  name: string | null;
  phone: string | null;
  email: string | null;
  statusCode: string | null;
  statusLabel: string | null;
}

/** An ISO 8601 instant as a string, or a `Date` the SDK serializes for you. */
export type Instant = string | Date;

/** Paging parameters every list endpoint accepts. */
export interface PageParams {
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Rows per page. The server defaults to 100 and caps it at 500. */
  limit?: number;
}

/** Filters the project and unit lists accept. */
export interface CatalogListParams extends PageParams {
  updatedSince?: Instant;
  createdSince?: Instant;
  includeCustomFields?: boolean;
  includeMedia?: boolean;
  /** One record by your own identifier (needs a key bound to an integration). */
  externalId?: string;
  /** Records bound (true) or not yet bound (false) to an identifier in your key's namespace (needs a key bound to an integration). */
  hasExternalId?: boolean;
}

export type ProjectListParams = CatalogListParams;

export interface UnitListParams extends CatalogListParams {
  /** Only the units of this project (its QubeHub id). */
  projectId?: number;
}

export interface LeadListParams extends PageParams {
  updatedSince?: Instant;
  createdSince?: Instant;
  includeCustomFields?: boolean;
  includeActivities?: boolean;
}

export interface LeadGetParams {
  includeActivities?: boolean;
}
