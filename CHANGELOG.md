# Changelog

All notable changes to this package are documented here. The project follows [Semantic Versioning](https://semver.org/).

## 0.1.0 (2026-11-05)

First release.

- `QubeHubClient` for the QubeHub Partner Data API v1: `whoami()`, project, unit and lead reads, and a generic `request()` for every other operation.
- `listAll()` and `paginate()` async iterators over paginated lists.
- HTTPS only (plain HTTP for a loopback host), and redirects are never followed, so the API key reaches only the configured host.
- `QubeHubApiError` with `status`, `errorCode`, `message`, `details` and `retryAfterSeconds` from the API's error envelope.
- `verifyWebhookSignature()` for the `X-Signature-256` header, with a timestamp tolerance and constant-time comparison.
- `parseWebhookEvent()` with types for entity events and the CRM's test event.
