# Frontend Development Guidelines

## Current scope

The native clients are Android (`clients/android`, Kotlin/Compose) and iPhone
(`clients/ios`, SwiftUI). Read [iOS client contracts](./ios-client.md) before changing
the Swift client, Xcode project, CI packaging or sideload delivery. The Fastify
server is API-only. The retired `packages/web` Vue/PWA application and its build, browser
and service-worker tools are no longer available. Do not use the old Web manuals as
current Android implementation instructions or acceptance evidence.

- Start with the [Android feature catalogue](../../../clients/android/README.md) for
  current behavior, stable feature IDs, API coverage, and known gaps. Follow the inventory
  maintenance rule in `AGENTS.md` for changes to Android or its consumed API contracts.
- Read [Quality Guidelines](./quality-guidelines.md) for Android gates, the retained-tab
  contract, and the API-only cache/404 checks. Device interaction evidence is separate
  from source, JVM tests, lint, or APK compilation.
- Read [Native Client Delivery](../backend/native-delivery.md) and the relevant backend
  feature spec for the actual API contract. Public Web hosting is retired.
- Read [Native account ownership](./native-account-state.md) before changing
  registration, account switching or persisted financial/import recovery.

## Accounting boundary

Android renders server results instead of independently re-deriving totals. Money is
integer cents. Ordinary refunds are income transactions (`type=1`, `isRefund=true`):
ordinary income includes the refund and ordinary expense and category-envelope spending
remain gross. Confirmed refund allocations reduce the separate four-purpose execution
view's net spending; they do not rewrite the ordinary ledger. For a 10000-cent expense
and 3000-cent refund, ordinary expense is 10000 and income is 3000; confirmed attributed
four-purpose spending is 7000. Preserve the distinction and shared calculation ownership.

## Historical Vue/PWA manuals — non-operative

The following documents describe the deleted Web client. They are retained only for
historical context, not as instructions, current toolchain requirements, or Android
implementation evidence. Their old commands, paths, tests, PWA, styling, navigation,
and accounting descriptions may be obsolete.

| Historical manual | Former subject |
|---|---|
| [Directory Structure](./directory-structure.md) | Vue module organization |
| [Component Guidelines](./component-guidelines.md) | Vue components and mobile rules |
| [Composables](./hook-guidelines.md) | Vue composables |
| [State Management](./state-management.md) | Pinia and Web state |
| [Type Safety](./type-safety.md) | Web TypeScript boundary |
| [Motion Guidelines](./motion-guidelines.md) | Web animation tokens |
| [Colour Guidelines](./color-guidelines.md) | Web theme tokens |

Documentation is written in English; user-facing UI copy is in Chinese.
