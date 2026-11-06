# Workspace v1 frozen client/server contract

All paths below start `/api/v1/assistant`; authenticated per-ledger and CSRF on POST.
This is additive to existing generation/event/action version1. Existing88 tools stay.
New iOS sends `clientCapabilities:["workspace-v1"]` alongside existing version,
clientRequestId,input on generation creation. Server returns the unchanged `{generation}`
snapshot (202 new /200 replay). Old requests stay byte-compatible; only negotiated
generations advertise `workspace.select/open`, `capabilities.list` and rich result controls.
Standalone `daily.review` stays compatible as an ordinary read/result tool for older clients.

## Result data

New result cards use the existing kind=result/content.result wrapper. Additive data:

```
workspace:{version:1,type:"selection",id,kind,title,multiple,expiresAt,status,
  items:[{id,title,subtitle?,amountCents?,date?}],
  page:{offset,limit,total,hasMore}}
nativeAction:{destination,itemId?}
```

Selection kind enum: account,category,tag,transaction,salary,date-range,item,recurring,
recurring-occurrence,goal,fund-source,transfer,trash. Optional item.facts carries server
revisions/source facts (retained server-side for continuation). Status:
pending,answered,cancelled. Selected resources come from authoritative services.
Native destination enum: provider-settings,invitations,password,data-import,
platform-import,data-export,item-photo,item-cutout,reminders,logout,server-switch.
item-photo/item-cutout require actual itemId. No executable URL.
New `workspace.select` read tool arguments: `{kind,question,multiple?,type?,q?,from?,to?,accountId?,categoryId?,tagId?}`;
type (0 expense/1 income) only filters categories/transactions; q is a bounded search.
Transaction filters retain their full authoritative scope; selected date-range facts
are inherited when a later bill/source/goal selector omits explicit from/to.
`workspace.open` read tool arguments `{destination,itemId?}`. `capabilities.list` `{}`.
`daily.review` read tool `{date:"YYYY-MM-DD",timeZone:"Asia/Shanghai"}`; direct daily
endpoint below preloads these authoritative facts before one normal streamed model turn.

GET `/workspace/capabilities` returns `{version:1,items:[{name,description,access}],
nativeActions:[{destination,title,requiresItem?,requiresCapability?}]}`; the `capabilities.list`
tool returns exactly the same under result.data. Invitations declare
`requiresCapability:"manageInvitations"`; the original admin API still authorizes the
actual mutation and the native router checks its authenticated user before opening.

## Typed selections

GET `/conversations/:cid/workspace/interactions/:iid?offset=0&limit=30&q=...`
returns `{interaction:<workspace-object-above>}`. Same snapshot/filter; no model calls.
POST `/conversations/:cid/workspace/interactions/:iid/answer`
body `{clientRequestId,selectedIds:[id,...]}` or
`{clientRequestId,dateRange:{from:"YYYY-MM-DD",to:"YYYY-MM-DD",timeZone:"Asia/Shanghai"}}`.
Returns `{generation:<existing-v1>,workflow:<below>}` (202 new/200 replay).
Single-selection requires one ID, multiple1..100, date range inclusive. No labels/args.
Membership/scope/expiry are checked server-side. Identical answer replays its original
generation; different answer/reused request ID conflicts409. Stale facts409, missing404.

## Workflow and confirmation continuation

GET `/conversations/:cid/workspace` returns `{workflow:null|{version:1,id,originalRequest,
phase,generationId,updatedAt}}`. Phase: reading,awaiting-selection,awaiting-confirmation,
reporting,awaiting-continuation,completed,failed,cancelled. Selected facts and approved references are stored privately
and added to later provider context, not inferred from recent20 messages.

Use existing `/actions/:actionId/confirm` unchanged. After confirmed response, explicitly
POST `/conversations/:cid/workspace/actions/:actionId/continue` with
`{clientRequestId}`. Returns `{generation,workflow}`. It validates confirmed ownership,
reuses one durable continuation generation per action and continues original intent.
Old generation POST/replay and SSE reducers do not change. Confirmation itself never
creates inference for old clients. A later write still emits a new pending approval card.

## Immutable draft revision

POST `/conversations/:cid/workspace/actions/:actionId/revise`
body `{clientRequestId,arguments:{...FULL new tool arguments...}}`.
Returns `{messages:[...existing message DTOs],action:{id,conversationId,status:"pending"}}`.
Server prepares through original tool/domain service, atomically cancels old pending
action and stores a replacement action/card with a new ID. On replay same request/body
returns same replacement; changed body409. Confirmed/expired/cancelled predecessor409.
No financial writes or inference. Preserve hidden revisions/tokens from full original
arguments supplied by GET next: GET `/.../actions/:actionId` returns
`{action:{id,conversationId,status,toolName,arguments,inputSchema}}`. inputSchema is the
original registry schema (type/properties/required), with immutable operation/revision/
token fields omitted from editable properties; original arguments retain those facts.
This is authenticated UI data;
the client shows editable business fields and retains immutable service facts.

## Direct result paging and organization selection

POST `/conversations/:cid/workspace/organization/card` body `{runId,offset,limit}`
returns `{result:{version:1,toolName:"spending.card",summary,data:<paged-card>}}`.
This reads the owned ready run directly; selectedIDs can persist across pages in the UI.

POST `/conversations/:cid/workspace/results/:messageId/page`
body `{offset,limit}` returns `{result:{version:1,toolName,summary,data}}`.
The server owns original tool/filter args from the persisted result descriptor, changes
only page offset/limit, and performs a read. No model round trip or composer text.
Applies offset-page result tools; cursor pages retain their domain cursor and use
the selection endpoint or an explicitly available continuation. Never fabricate cursors.

POST `/conversations/:cid/workspace/organization/prepare`
body `{clientRequestId,kind:"spending",runId,actionIds:[...]}` or
`{clientRequestId,kind:"structural",previewMessageId,actionIds:[...]}`.
Returns `{messages,action:{id,conversationId,status:"pending"}}`. No model invocation;
only explicit eligible selected IDs,1..100, actual domain preview and existing confirm.

## Daily notification launch

POST `/conversations/:cid/workspace/daily-review`
body `{clientRequestId,date:"YYYY-MM-DD",timeZone:"Asia/Shanghai"}`.
Returns `{generation,workflow}` 202 new/200 replay. Server freezes exact day/zone,
preloads `daily.review` facts including complete salary window (ordinary daily totals
alone exclude salaries), then uses existing provider stream. Report is read-only and
cannot create pending writes. Request replay uses same generation, including uncertainty.

## Native CSV import (root native workspace)

POST `/data-import/preview` body
`{kind:"transactions"|"transfers",csv:<raw text>,clientRequestId}`.
Returns `{preview:{id,kind,expiresAt,columns:[string],rows:[[string]],totalRows,
rowsOmitted:boolean,result:<existing import result>}}` (200; preview only).
Maximum CSV2MiB; show up to100 source rows with explicit total/omission. Validation
runs real import in rollback. Persist only file digest/review result/ledger fingerprint,
never CSV bytes in model history. Exact request replay returns same preview.
POST `/data-import/:previewId/confirm` body `{csv:<same raw text>}` returns
`{result:<existing import result>}`. Check digest and unchanged ledger, execute once,
persist result atomically. Identical confirmation replays; changed file/stale ledger409.
Preview20-minute expiry. The dedicated native screen owns file, explicit review and consent.

## Errors and transport

Existing safe error envelope `{error:{code,message}}`; workspace invalid400,
notfound404,stale/conflict409. Metadata-only trace strips old argument summaries at read
boundary and never persists raw argument strings/numbers. Results stay <=40KiB, complete
financial previews <=48KiB. These endpoints are enum/domain-specific, not generic HTTP.
# Native completion continuation (additive H5 contract)

`POST /api/v1/assistant/conversations/:cid/workspace/native-completions`

```json
{
  "clientRequestId": "native-completion-frozen-id",
  "sourceMessageId": "original-workspace-open-result-message-id",
  "reference": { "kind": "csv-import", "previewId": "confirmed-preview-id" }
}
```

`reference` is exactly one of:

- `{kind:"csv-import",previewId:string}`
- `{kind:"platform-import",batchId:string}`
- `{kind:"item-photo",itemId:string,operation:"saved",sha256:string}`
- `{kind:"item-photo",itemId:string,operation:"viewed",sha256:string}`
- `{kind:"item-photo",itemId:string,operation:"removed"}`
- `{kind:"export",exportKind:"transactions"|"salaries"|"recurring"|"transfers"}`

Saved/viewed photo SHA256 is lowercase64 hexadecimal over the exact current raw image bytes.
Removal omits sha256. Unknown fields and unlisted kinds are rejected.
Response is the existing `{created,generation,workflow}` envelope:202 new,200 replay.
Use normal generation/SSE recovery after accepting the response. The client calls only
after actual native success and retains the same frozen request through uncertainty.

The source must be the owned completed assistant `workspace.open` result message with
the matching nativeAction destination/item and a durable source-generation workflow.
CSV and batch receipts must be confirmed at or after the source message; batch ownership
includes the conversation. Legacy CSV receipts without a confirmation timestamp remain
ordinary import-confirm replayable but cannot claim a new native completion.
Photo validation proves current matching bytes or current absence, not client causation.
Export re-reads the actual allowlisted server export and proves current server generation,
not local save or OS Share completion. Secrets/file bytes/client prose are never receipts.
Canonical request and source/reference replay create exactly one continuation and persist
the verified `lastNativeOutcome` in the original workflow. Later edits still need approval;
an inherited daily-review workflow remains read-only. Credential/logout/server-switch
flows have no native-completion reference and cannot resume across invalidated auth scope.
