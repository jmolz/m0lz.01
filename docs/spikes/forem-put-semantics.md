# Forem PUT Semantics Spike — Phase 7 Cluster E6

> Generated as part of the Phase 7 plan. Documents the exact Forem API
> request shape used by `src/core/unpublish/devto.ts` and
> `src/core/publish/devto.ts :: updateDevToArticle`.

## Endpoint

```
PUT https://dev.to/api/articles/{id}
Headers:
  api-key: $DEVTO_API_KEY
  Content-Type: application/json
  Accept: application/json
```

## Unpublish request (Phase 7 Cluster E3 `unpublishFromDevTo`)

Body:

```json
{
  "article": {
    "published": false
  }
}
```

Observed responses:

| Status | Meaning | Action |
|--------|---------|--------|
| 200 | Article updated; `data.published === false` | Cycle step returns `completed` with the (now-unpublished) article URL. |
| 401 | Missing or invalid `api-key` | Step throws; operator rotates credentials and retries. |
| 404 | Article id no longer exists (manual deletion on Dev.to) | Upstream probe already returned miss; step returns `skipped`. |
| 422 | Validation error (shouldn't happen for a pure `published: false` flip) | Step throws with the Forem error message for debugging. |
| 5xx | Dev.to outage | Step throws; retry via `blog unpublish start <slug>` when service recovers. |

Notes:

- `body_markdown` is NOT required on a PUT that only flips `published`.
  The Forem API preserves the existing body.
- The authoritative probe path is `GET /api/articles/me/all` (paginated),
  which returns the article id when the canonical_url matches. We never
  do a write without first confirming the id via probe — the probe-miss
  branch returns `skipped`, not an error.

## Update request (Phase 7 Cluster C4 `updateDevToArticle`)

Body:

```json
{
  "article": {
    "title": "...",
    "body_markdown": "...",
    "canonical_url": "https://m0lz.dev/writing/{slug}",
    "tags": ["..."],
    "description": "..."
  }
}
```

- `body_markdown` IS required to actually update the rendered body
  (omitting it leaves the prior body unchanged).
- The 422 branch shape matches POST — surface the error text for
  visibility.
- On probe-miss (article was manually deleted), fall through to POST
  — recovers from operator deletion gracefully.

## Trust boundary

- Every mutation is **probe-then-PUT**. Never PUT blind by id from a
  cached local row; the canonical-URL probe is the single source of
  truth for article identity. This guards against Dev.to account
  migrations where ids change but canonical URLs persist.
- Trailing slashes on canonical URLs are normalized (via
  `canonicalUrl.replace(/\/+$/, '')`) so an author whose Dev.to data
  stores the URL with a slash still matches the probe.
