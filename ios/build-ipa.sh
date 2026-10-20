#!/usr/bin/env bash
#
# Builds an unsigned Resonance.ipa locally on macOS.
# CI does the same thing in .github/workflows/ios-ipa.yml.
#
# Usage:  ./ios/build-ipa.sh [output-directory]
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$REPO_ROOT/ios"
OUT_DIR="${1:-$REPO_ROOT/build}"
ARCHIVE="$OUT_DIR/Resonance.xcarchive"

if ! command -v xcodebuild >/dev/null 2>&1; then
    echo "xcodebuild not found — this script needs macOS with Xcode installed." >&2
    exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
    echo "xcodegen not found — install it with: brew install xcodegen" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
rm -rf "$ARCHIVE" "$OUT_DIR/Payload" "$OUT_DIR/Resonance.ipa"

echo "==> Generating Xcode project"
(cd "$IOS_DIR" && xcodegen generate --spec project.yml)

echo "==> Archiving (unsigned)"
xcodebuild \
    -project "$IOS_DIR/Resonance.xcodeproj" \
    -scheme Resonance \
    -configuration Release \
    -sdk iphoneos \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE" \
    CODE_SIGN_IDENTITY="" \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGN_ENTITLEMENTS="" \
    archive

echo "==> Packaging IPA"
(cd "$OUT_DIR" && mkdir -p Payload && cp -R "$ARCHIVE/Products/Applications/Resonance.app" Payload/ && zip -qry Resonance.ipa Payload && rm -rf Payload)

echo "==> Result"
ls -lh "$OUT_DIR/Resonance.ipa"
echo "Sideload it with AltStore, Sideloadly or TrollStore (they re-sign it for your device)."
