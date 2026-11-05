# iOS assistant functional completion

The user authorized continuing on original `main`, with existing four-purpose allocation rather than new custom purposes. The new assistant scope supersedes preview-only delivery.

- Persisted action cards expose detailed review, explicit confirmation and cancellation. Response identity/status is validated before ledger invalidation. History remains authoritative; late operations only update their origin conversation.
- Duplicate taps are blocked. Ambiguous confirmations keep the original action ID and exact body; ambiguous cancellations can only retry cancellation. Definite 4xx rejections (except timeout) release editable state. Reload resolves a lost successful response without creating another action.
- Read cards expose nested business details, exact integer money and context-specific account/transaction types. Historical spending suggestions have explicit selection, pagination requests, expiry and reference-only note suggestions; selection prepares a further confirmation card through conversation.
- Single WeChat XLSX/Alipay CSV upload uses the existing attachment endpoint. Files are bounded to 5 MB and held in memory. Import review explicitly selects 1–100 eligible rows and permits category/note corrections; SHA-256 and size must match the original preview. Retried confirmation preserves selections/file body.
- File upload and generation identities are distinct. An ambiguous upload reuses its client request ID; an early replay response indicates the preview may still be running and can be refreshed. There is no automatic paid inference retry.
- The root navigation restores a visible accounting button on Home/Bills/Plan. Item purchase/sale bill links use the shared detail sheet. Actual successful mutations broadcast only through the current API instance.

Regression sources cover double taps, lost success, late results after conversation changes, frozen import retries, explicit rejection recovery, non-selected/expired history proposals, original-file identity, UTF-16 note bounds, integer money and domain-specific type presentation. Simulator render sources cover compact action review and larger-text historical suggestions. Actual Xcode results are recorded separately after CI; source checks do not establish device acceptance.

Known retained boundaries: merged multi-file import uses its existing Android workspace; bill/plan draft recovery survives sheet reopening within the active session, not app process termination; uploaded file bytes are not persisted. Production backend deployment, live provider behavior and physical installation are separate from repository and CI acceptance.
