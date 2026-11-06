# Current delivery — original repository/main

Latest 2026-11-06 bill modal/filter/statistics polish: see
[bill-ui-polish-verification.md](./bill-ui-polish-verification.md) for the verified
build-12 IPA, 133 native tests, actual UI review and checksum.

The current 2026-11-05 functional-completion delivery is recorded in
[functional-verification.md](./functional-verification.md). Its code is in
`yansuui/jizhang` on `main`, including bill/refund editing, allocation controls and
confirmed assistant business tools. Use that document's newest IPA/run rather than
the historical first-delivery artifact below.

# Historical first delivery — 2026-11-04

## Prepared artifact

- Build: [GitHub Actions run 41819877293](https://github.com/yangguangxiaobai/jizhang/actions/runs/41819877293), successful.
- Source commit: `e8734cc4d073abc54e916e0bd36b6c0ae866a206` on `feat/ios-assistant` in `yangguangxiaobai/jizhang`.
- Version: `0.1.0` (build `4`); minimum iOS `17.0`; bundle ID `com.yansuu1.jizhang.ios`.
- Local ready file: `clients/ios/build/delivery/Jizhang-iOS-0.1.0-build4.ipa` (1,922,622 bytes).
- Original downloaded artifact: `clients/ios/build/downloads/41819877293/`.
- SHA-256: `b2f670ad24ab08c05a89e01669f124f847be2b3ec3b1e1eb185f7557969191cb`.
- IPA is an unsigned **device** build. Sideloadly supplies local signing; it cannot be opened directly on an iPhone as an already-signed app.

## Executed verification

- Xcode 16.4 (16F6), macOS 15 Intel runner: project/plist validation, simulator XCTest, Release iPhone compilation and IPA packaging all succeeded.
- All **77 tests passed**, zero failures. Coverage includes transport/cookies/ownership, monetary contracts, AI streaming/reconciliation, delayed submission/list races, provider preservation/bootstrap and read-only refresh behavior.
- Simulator: iPhone SE (3rd generation), iOS 18.5. Inspected actual login launch image and the three exported SwiftUI fixtures (conversation list, compact config, large-text dark config).
- The fixtures use a 390 × 844-point hosting window and a visible test-data banner. They demonstrate layout with synthetic data, not live-provider acceptance or physical-device operation.
- `download-ipa.ps1` verified successful run status, artifact checksum and exact commit. Local independent ZIP checks confirmed no corrupt entries, the expected `Payload/Jizhang.app`, `iPhoneOS` platform, arm64 Mach-O executable, matching bundle/version/minimum OS and no XCTest runtime in the Release package.
- Source whitespace checks passed. No Android/backend implementation or production provider configuration was changed.

## Observed limits and next step

- The unsigned simulator launch displayed the secure-storage error. Its logs contain `SecTaskLoadEntitlements failed error=22`, consistent with disabled simulator signing. Keychain behavior and real login must be verified after Sideloadly signs the device package; the passing transport tests use isolated credential stores.
- Keyboard interaction, history scrolling during real generation and live-provider behavior remain device/manual acceptance. No live inference was sent during development.
- Existing Sideloadly: `D:/Sideloadly/Sideloadly.exe`, v0.72. Inspection reported no connected device. The user explicitly chose **“稍后连接，先准备 IPA”**. Installation has therefore not been attempted or claimed.
- When the user connects the phone, inspect Sideloadly's current device/OS, load the verified IPA above, check app identity/options, and sign/install locally. User completes any Apple authentication, trust or Developer Mode prompts. Do not ask for the Sideloadly path again.
- Keep the task active for this deferred device acceptance; the IPA preparation phase is complete.

GitHub reported an Actions performance degradation during this delivery, alongside intermittent Git/API failures. The final successful run and local artifact verification above are the delivery evidence.

## Repository destination update — 2026-11-05

The user requested direct submission to `yansuui/jizhang` instead of using a fork. `origin` already points to this original repository; the local branch's push destination and the IPA download helper now default to it. The build-4 evidence above remains tied to its original fork run and must not be relabelled as an upstream build. To retrieve that historical run with the helper, explicitly pass `-Repository yangguangxiaobai/jizhang`.
