#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/artifacts build/logs
python3 scripts/generate_project.py
plutil -lint Jizhang.xcodeproj/project.pbxproj Jizhang/Info.plist Jizhang/Jizhang.entitlements \
  Jizhang/PrivacyInfo.xcprivacy JizhangWidgets/Info.plist JizhangWidgets/JizhangWidgets.entitlements
xcodebuild -version | tee build/logs/xcode-version.log
xcodebuild -list -project Jizhang.xcodeproj | tee build/logs/project.log

simulator_id="$(python3 scripts/select_simulator.py)"
printf 'Using iPhone simulator %s\n' "$simulator_id"
xcodebuild -project Jizhang.xcodeproj -scheme Jizhang -configuration Debug \
  -destination "platform=iOS Simulator,id=$simulator_id" \
  -derivedDataPath build/SimulatorDerived -resultBundlePath build/TestResults.xcresult \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO test 2>&1 | tee build/logs/tests.log

xcrun xcresulttool export attachments --path build/TestResults.xcresult --output-path build/artifacts/previews

xcodebuild -project Jizhang.xcodeproj -scheme Jizhang -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath build/DeviceDerived \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY='' \
  CURRENT_PROJECT_VERSION="${GITHUB_RUN_NUMBER:-1}" build 2>&1 | tee build/logs/device-build.log

app_path="$PWD/build/DeviceDerived/Build/Products/Release-iphoneos/Jizhang.app"
test -f "$app_path/Jizhang"
lipo "$app_path/Jizhang" -verify_arch arm64
widget_path="$app_path/PlugIns/JizhangWidgets.appex"
test -f "$widget_path/JizhangWidgets"
lipo "$widget_path/JizhangWidgets" -verify_arch arm64
mkdir -p build/package/Payload
ditto "$app_path" build/package/Payload/Jizhang.app
ditto -c -k --keepParent build/package/Payload build/artifacts/Jizhang-unsigned.ipa
(
  cd build/artifacts
  shasum -a 256 Jizhang-unsigned.ipa > SHA256SUMS.txt
)
python3 - <<'PY'
import json, os, plistlib, subprocess
from pathlib import Path
products = Path('build/DeviceDerived/Build/Products/Release-iphoneos')
info = plistlib.loads((products / 'Jizhang.app/Info.plist').read_bytes())
assert info['CFBundleSupportedPlatforms'] == ['iPhoneOS'], info['CFBundleSupportedPlatforms']
widget = plistlib.loads((products / 'Jizhang.app/PlugIns/JizhangWidgets.appex/Info.plist').read_bytes())
assert widget['NSExtension']['NSExtensionPointIdentifier'] == 'com.apple.widgetkit-extension', widget['NSExtension']
assert widget['CFBundlePackageType'] == 'XPC!', widget['CFBundlePackageType']
# An installed extension must carry exactly the app's short version and build number.
assert widget['CFBundleShortVersionString'] == info['CFBundleShortVersionString'], widget
assert widget['CFBundleVersion'] == info['CFBundleVersion'], widget
metadata = {
    'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'runId': os.environ.get('GITHUB_RUN_ID'),
    'bundleId': info['CFBundleIdentifier'],
    'version': info['CFBundleShortVersionString'],
    'build': info['CFBundleVersion'],
    'minimumOS': info['MinimumOSVersion'],
    'widget': {
        'bundleId': widget['CFBundleIdentifier'],
        'extensionPoint': widget['NSExtension']['NSExtensionPointIdentifier'],
        'build': widget['CFBundleVersion'],
    },
    'signing': 'Unsigned device IPA; sign locally with Sideloadly',
    'xcode': subprocess.check_output(['xcodebuild', '-version'], text=True).strip(),
}
Path('build/artifacts/build-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
PY

# A real simulator launch image, separate from source and unit-test evidence.
xcrun simctl bootstatus "$simulator_id" -b
xcrun simctl install "$simulator_id" build/SimulatorDerived/Build/Products/Debug-iphonesimulator/Jizhang.app
xcrun simctl launch "$simulator_id" com.yansuu1.jizhang.ios
sleep 3
xcrun simctl io "$simulator_id" screenshot build/artifacts/launch.png
