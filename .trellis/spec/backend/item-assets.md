# Personal Item Assets — Executable Contract

This contract covers the independent item-inventory feature. Items are not ledger entries and
must not change transactions, balances, budgets, or financial statistics.

## 1. Scope / Trigger

- Trigger: additive SQLite migration plus authenticated API and native-client data-flow contract.
  The Web client and its browser tests are retired.
- Use this contract when changing item records, lifecycle transitions, photos, or optional links
  to existing transactions.
- Private automatic photo cutout is in scope through the bounded proxy contract below. Visual
  recognition, receipt OCR, and automatic ledger writes remain out of scope.

## 2. Signatures

### Database

- Migration: `010-item-assets`.
- `asset_items` stores one item record: `id`, `name`, `category`, `brand`, `model`, `note`,
  nullable `purchase_price_cents`, required `purchase_date`, `status`, nullable `closed_date`,
  nullable `sale_price_cents`, nullable purchase/sale transaction IDs, soft-delete flag, and
  timestamps.
- `asset_item_photos` stores at most one image per item as `{ item_id, mime_type, image_bytes,
  updated_at }`; its BLOB is included in the existing SQLite snapshot backup.
- These tables are additive. Do not add a foreign key from item records to transactions: bills
  may be deleted or purged while item history remains readable.

### HTTP API

- `GET /api/v1/items?status=&category=&q=&limit=&offset=` →
  `{ items: ItemDto[], total, limit, offset }`.
- `GET /api/v1/items/summary` → item-only status counts, cumulative purchase cents, and current
  daily-cost cents.
- `GET /api/v1/items/:id` → `ItemDto`.
- `POST /api/v1/items` → `201 ItemDto`; input includes required `name`, `purchaseDate` (local-date
  epoch milliseconds), optional `category`, `purchasePriceCents`, `brand`, `model`, `note`,
  `status` (`active` or `idle`), and `purchaseTransactionId`.
- `PATCH /api/v1/items/:id` → `ItemDto`; accepts partial editable item fields. Use the dedicated
  lifecycle endpoints to close an open item.
- `DELETE /api/v1/items/:id` → `204`; soft-deletes only the item.
- `POST /api/v1/items/:id/sell` input `{ closedDate, salePriceCents?, saleTransactionId? }`;
  `POST /api/v1/items/:id/retire` input `{ closedDate }`; both return `ItemDto`.
- `PUT /api/v1/items/:id/photo` accepts raw JPEG, PNG, or WebP bytes; `GET` at the same path
  returns the authenticated image; `DELETE` removes it.

`ItemDto` uses camelCase fields: `id`, `name`, `category`, `brand`, `model`, `note`,
`purchasePriceCents`, `purchaseDate`, `status`, `closedDate`, `salePriceCents`,
`purchaseTransactionId`, `saleTransactionId`, `photoUrl`, `heldDays`, `netCostCents`,
`dailyCostCents`, `createdAt`, and `updatedAt`.

## 3. Contracts

- All routes are registered inside the authenticated `authModule.extraRoutes` plugin. Reads
  require a session; writes also require `X-Requested-With: fetch`.
- Money is integer cents. Dates are local-calendar epoch milliseconds. The server owns all
  holding-day and daily-cost arithmetic; clients format returned values only.
- Statuses are `active`, `idle`, `sold`, and `retired`. Open items have no `closedDate`. Sold and
  retired items require a close date. A sale's proceeds and sale link may be unknown.
- Purchase transaction links must point to a live, non-refund expense. Sale links must point to a
  live, non-refund income. Links are informational: create/edit/sell/retire never create, update,
  or delete ledger rows. A later deletion of a linked transaction does not invalidate the item.
- `heldDays = max(0, localDay(closeDate ?? today) - localDay(purchaseDate))`.
- For active/idle/retired records, `netCostCents = purchasePriceCents`. For sold records,
  `netCostCents = purchasePriceCents - salePriceCents`. `dailyCostCents` is rounded net cost
  divided by held days; it is `null` when net cost is unknown or held days is zero. Negative sold
  net cost is valid.
- Photo payload limit: 2 MiB. Only JPEG/PNG/WebP are accepted; validate MIME/signature and image
  dimensions (maximum 40 million pixels). List DTOs never contain image bytes. The photo GET is
  session-protected and responds with `Cache-Control: no-store` and `X-Content-Type-Options:
  nosniff`.
- Item categories are free text/default to `其他`; they are not expense/income categories.
- All item endpoints use the existing `{ error: { code, message } }` API error envelope.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing session | `401` |
| Write without CSRF request header | `403` |
| Missing item or missing photo | `404` |
| Malformed field, future purchase date, invalid link/type, or close date before purchase/after today | `400` |
| Attempt to sell/retire a non-open item | `409` |
| Photo exceeds 2 MiB | `413` |
| Unsupported MIME, invalid image signature/dimensions, or more than 40 million pixels | `400` |
| Unknown/deleted transaction supplied as a new link | `400`; an already-stored stale link does not block unrelated edits |

## 5. Good / Base / Bad Cases

- **Good:** create a camera body with a known purchase amount and date; optionally link a live
  purchase expense; later sell it and optionally link a live income. Item history updates while
  ledger rows and financial projections remain unchanged.
- **Base:** create an item with an unknown price, or a same-day purchase; return `null` for daily
  cost rather than inventing a value.
- **Bad:** create a transaction as a side effect of saving the item, link income as the purchase,
  accept an SVG as an image, or compute holding cost independently in a client.

## 6. Tests Required

- `packages/server/test/db.test.ts`: assert both tables exist after fresh initialization and
  migration is repeatable.
- `packages/server/test/items.test.ts`: assert session/CSRF guards, CRUD/filter/search, field and
  date validation, lifecycle transitions, transaction-link types, ledger/stat/budget invariance,
  image MIME/size/dimension limits, authenticated no-store/nosniff retrieval, and photo bytes
  surviving a backup/restore snapshot.
- `packages/server/test/items.test.ts`: also assert linking existing bills and retiring an item
  preserve transaction counts, purchase price and link; a missing photo returns JSON 404, and
  transparent WebP bytes survive upload and retrieval.
- Run server lint, typecheck and relevant server tests after changing this contract or its
  implementation. Native UI/device acceptance is separate from API tests and compilation.

## 7. Wrong vs Correct

### Wrong

```ts
// Saving an inventory record must not write a second financial fact.
await api.transactions.create({ type: TYPE_EXPENSE, amountCents: item.purchasePriceCents });
```

### Correct

```ts
// Store an optional reference only; the server verifies its purpose and leaves the bill intact.
await api.items.create({ ...item, purchaseTransactionId: selectedExistingExpenseId });
```

## Scenario: Private automatic item-photo cutout

### 1. Scope / Trigger

- Trigger: add automatic background removal to the existing item-photo draft flow without
  creating a ledger entry or changing item/photo persistence.
- Use only unlabeled segmentation proposals; object naming, classification, and automatic
  candidate selection are not part of this contract.

### 2. Signatures

- `POST /api/v1/items/cutouts` accepts raw `image/webp`, `image/jpeg` or `image/png` bytes and returns
  `202 { jobId: string }`.
- `GET /api/v1/items/cutouts/:jobId` returns `{ jobId, state, message, candidates }`, where
  `state` is `queued | running | ready | failed | cancelled`, and ready candidates contain
  only `{ id, width, height }`.
- `GET /api/v1/items/cutouts/:jobId/candidates/:candidateId/preview` returns a WebP preview;
  the matching `/image` endpoint returns one transparent PNG candidate.
- `DELETE /api/v1/items/cutouts/:jobId` cancels work or removes a completed transient result.
- `JIZHANG_ITEM_CUTOUT_SERVICE_URL` is optional. Compose sets it to the private worker URL;
  absent means ordinary photo upload stays enabled and cutout returns `503`.

### 3. Contracts

- Register every public cutout route inside the same authenticated `authModule.extraRoutes`
  plugin as item CRUD. Reads require a session; `POST` and `DELETE` also require the existing
  CSRF header.
- Clients call Fastify only. Fastify proxies to the Python worker on a dedicated Docker
  internal network. The worker has no published host port and accepts no client session cookies.
- Accept prepared JPEG/PNG/WebP drafts (<=2 MiB, <=40 MP); validate declared and decoded
  formats before normalization. Android keeps its existing WebP preparation, while iOS
  prepares JPEG/PNG without an external codec. The worker retains its bounded resize.
  Keep one active job plus one queued job, at most three retained results, at most eight
  candidates, and a 120-second job deadline. Expire retained results after ten minutes.
- Store source images, normalized PNGs, masks, and candidate files only in the worker's
  transient 512 MiB `tmpfs`; clean them on cancel, expiry, and worker shutdown. Do not put
  image bytes or job rows into SQLite, logs, backups, or persistent volumes.
- The 120-second deadline marks an overdue job failed and requests cooperative cancellation.
  A PyTorch call already in progress cannot be interrupted by its Python thread; continue
  counting that `Future` against the active-worker cap until it returns. If it never returns,
  restart only the cutout container; the Fastify app and item data remain available.
- Set `Cache-Control: no-store` on all public responses and `X-Content-Type-Options: nosniff`
  on image responses. Bound worker JSON to 64 KiB, previews to 2 MiB, and each PNG to 16 MiB
  while streaming; reject bad or oversized upstream bodies before buffering them.
- Selecting a candidate changes only the current form draft. Persist it only when the user
  submits the existing item form, through `PUT /api/v1/items/:id/photo`; the previous saved
  photo stays intact until that point. No cutout operation reads or writes ledger rows.
- The worker is capped at two CPUs and 3 GiB memory with swap disabled for that container; the
  Fastify container keeps its existing 256 MiB heap/container budget. A worker outage must not
  make item CRUD or ordinary photo upload unavailable.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing session / mutating request without CSRF | `401` / `403` |
| Service disabled, unreachable, or returns 5xx | `503 CUTOUT_UNAVAILABLE` |
| Worker queue full | `429 CUTOUT_BUSY` |
| Missing/expired job or candidate | `404 CUTOUT_JOB_NOT_FOUND` / candidate-not-found |
| Job result not ready | `409 CUTOUT_NOT_READY` |
| Invalid/mislabeled or unsupported image input | `400 CUTOUT_INVALID_IMAGE` |
| Input exceeds 2 MiB | `413` |
| Invalid or over-limit worker JSON/image body | `502 CUTOUT_UPSTREAM_INVALID` |
| No useful masks | `200 ready` with an empty candidate list; preserve the original draft |

### 5. Good / Base / Bad Cases

- **Good:** select a generated candidate, verify the preview, then save the item. The selected
  transparent photo is stored by the existing photo endpoint and transaction counts/balances
  remain unchanged.
- **Base:** inference is unavailable or returns no candidates; keep the original photo draft
  and allow a normal item save/upload.
- **Bad:** save the original/candidate automatically, expose the Python port publicly, retain
  uploaded images on a host volume, or describe generic masks as object recognition.

### 6. Tests Required

- `packages/server/test/item-cutouts.test.ts`: assert session/CSRF, content signature/size,
  disabled service, typed proxy responses, no-store/nosniff, and streamed JSON/image byte caps.
- `packages/cutout/tests/test_service.py`: use a fake engine to assert bounds, queue behavior,
  cancellation/cleanup, private headers, and preservation of transparent source pixels.
- `packages/server/test/item-cutouts.test.ts`: assert the create/status/candidate/cancel cycle
  creates no item, photo or ledger rows, and upstream failure or an empty ready result leaves
  ordinary photo upload available. Mock the worker at the Fastify transport seam so auth/CSRF
  wiring is exercised. Native draft selection and cancellation require separate client/device
  acceptance; API tests do not prove those interactions.
- Before enabling in production, build the pinned CPU worker and benchmark at least twelve
  public/synthetic non-personal images: warm p95 <=45 seconds and peak RSS <2.5 GiB. If this
  gate fails, tune and remeasure or stop; do not silently remove the resource caps.

### 7. Wrong vs Correct

#### Wrong

```ts
// Do not persist every generated result or create an item before explicit form submission.
await api.items.uploadPhoto(itemId, 'image/png', generatedCandidate);
```

#### Correct

```text
Keep the selected candidate in the client draft; upload it through the existing photo
endpoint only after the user submits the item form.
```


### Release regressions: physical work and asynchronous drafts

- Job admission must count physically occupied active/waiting slots, not only public states.
  A timed-out running job remains charged after DELETE until its inference actually returns.
  Hold waiting work outside the executor queue; cancel its Future before releasing that slot.
  Repeated timeout -> DELETE -> retry must never accumulate executor work or delete files
  still owned by a running inference. Cover both queued cancellation and queued timeout.
- A candidate download/compression captures the current draft generation and job id. Recheck
  both after every await and before success, error, or finally mutations. Photo removal,
  replacement, cancellation, and unmount invalidate the generation. A late response must
  not resurrect a removed photo or clear the processing flag of a newer selection.
- Root cause: treating a public failure as physical completion, and assuming asynchronous
  selection still owns the draft. Regression tests cover timeout/delete/retry capacity and
  late successful/failed candidate downloads after explicit removal.
