# Verification and delivery

## Scope and source

User approved implementation on 2026-11-05. Work is on original repository
`yansuui/jizhang`, branch `feat/multiuser-invites`, based on the delivered iOS work.
No fork, production database, remote service or physical phone was modified.

Completed source: central identity and invitation registration; original-owner
cutover; all 15 business route factories scoped to private ledger contexts;
background/SSE/file/worker ownership; compact iOS/Android auth and invitation UI;
stable-ID client persistence; coordinated offline full-system backup and restore.
Independent review corrected late service construction during shutdown, request
leases after disconnect, nested financial actor propagation, and legacy CLI
maintenance locks. Existing CSV header/row and fund-purpose round-trip defects
were fixed with compatibility regressions.

## Local verification

- Toolchain: isolated Node 22.23.4 and repository-pinned pnpm 10.12.2. Frozen-lockfile
  install used official npm registry after the machine's mirror stalled. No global
  Node configuration was changed.
- Workspace lint, shared/server typecheck and production build passed.
- Full shared suite: 405 passed. Initial full server pass: 1,211 passed, four
  failures. Three failures were expensive byte-by-byte SQLite Buffer assertions;
  native `Buffer.equals` retains exact comparison and corrected those timeouts.
  The fourth collected an earlier CLI module while its lock fix was being edited.
- Latest focused reruns: CLI 32/32, platform import 16/16, tenancy isolation 10/10,
  assistant 20/20, portability 41/41. Identity/auth 44 plus the later active-code
  history regression passed. Existing streaming 36, app 18 and cutout 6 passed.
- Rich migration preservation fixture passed: purchase/refund, renamed category,
  encrypted provider secret, chat history and item photograph survive cutover,
  registration and two reopen cycles; invited ledger has no owner data or key.
- Native Android local Gradle could not reach configuration (distribution-lock
  timeout; no SDK found). GitHub Ubuntu gates are the native verification path.
- Container script syntax passed; Docker is not installed locally. The GitHub
  container job builds the actual image and exercises isolated bootstrap, two
  users, lock refusal, full backup/restore and recovered-directory login.

## iOS delivery

- Commit: `351bcffb1df9290fa668b2369aaa35b6437f4369`.
- Successful original-repository run:
  https://github.com/yansuui/jizhang/actions/runs/41959913496
- Xcode 16.4, 90 XCTest tests passed; native arm64 iPhoneOS Release build passed.
  Registration and large-text administrator previews were visually inspected.
- Version 0.1.0, build 2, minimum iOS 17.0, bundle `com.yansuu1.jizhang.ios`.
- Local handoff: `clients/ios/build/delivery/Jizhang-iOS-multiuser-351bcff.ipa`
  (2,024,304 bytes). SHA256:
  `6a4ca7ac8b2005fe0b73d678ba2f0e2bcd4dd7bfa53dd0817921276f01aa3a6b`.
- Archive integrity, artifact checksum, platform plist and Mach-O arm64 header
  verified locally. Unsigned IPA is ready for the user's existing Sideloadly.
  Physical installation remains deferred; no Apple credentials entered or uploaded.

## Complete-source CI

Source commit `ebe94530a415ee7ea7891dd72de3aa47722275f1` is pushed to the original
repository. Run: https://github.com/yansuui/jizhang/actions/runs/41961877280

- Backend job `127029897752` passed all lint, typecheck, tests and build. Clean-run
  totals: shared 405 tests in 13 files; server 1,217 tests in 62 files; **1,622 tests
  across 75 files passed**. This includes the final migration and isolation cases.
- Container job `127029897343` passed the actual production image build and the
  complete isolated lifecycle drill, including runtime user `node`, administrator
  and member login, invitation consumption/403, live backup lock rejection,
  three-database snapshot/verification/restore, and both accounts logging into the
  restored `DATA_DIR` in a real server process.
- Android job `127029897515` passed `:app:testDebugUnitTest`, `:app:assembleDebug`
  and `:app:lintDebug`; `Android-verification-1` contains the APK and reports.
  The downloaded HTML report records 589 tests, zero failures and zero ignored;
  lint records zero errors and 47 warnings. No Android CI source repair was
  necessary. The complete workflow succeeded.
- Android handoff: `artifacts/multiuser-android-41961877280/outputs/apk/debug/app-debug.apk`,
  22,161,580 bytes, verified ZIP integrity and SHA256
  `a3b480179f52df784f123b39ea28546d5c64c8eb0e33491c2db0fffc3e13fa74`.

Production upgrade remains a separate operation using `docs/MULTIUSER.md`.
