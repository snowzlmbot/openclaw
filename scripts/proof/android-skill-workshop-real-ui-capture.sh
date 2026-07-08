#!/usr/bin/env bash
set -euo pipefail

mkdir -p proof-output
APK="apps/android/app/build/outputs/apk/play/debug/app-play-debug.apk"
: "${AVD_NAME:=OpenClaw_Skill_Workshop_API35}"
APP_ID="ai.openclaw.app"
SETTINGS_TEXT="Settings"
SKILL_WORKSHOP_TEXT="Skill Workshop"

emulator -avd "$AVD_NAME" -no-window -no-snapshot -no-snapshot-save -gpu swiftshader_indirect -memory 2048 -cores 2 > proof-output/emulator.log 2>&1 &
EMU_PID=$!
cleanup() {
  timeout 5 adb emu kill >/dev/null 2>&1 || true
  wait "$EMU_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_text() {
  local needle="$1"
  local attempts="${2:-25}"
  local out="proof-output/openclaw-ui.xml"
  for _ in $(seq 1 "$attempts"); do
    timeout 20 adb shell uiautomator dump /sdcard/openclaw-ui.xml >/dev/null 2>&1 || true
    timeout 20 adb pull /sdcard/openclaw-ui.xml "$out" >/dev/null 2>&1 || true
    if [ -f "$out" ] && grep -Fq "$needle" "$out"; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for UI text: $needle" >&2
  return 1
}

text_center() {
  local needle="$1"
  python3 - "$needle" proof-output/openclaw-ui.xml <<'PY'
import html
import re
import sys
from pathlib import Path
needle = sys.argv[1]
xml = Path(sys.argv[2]).read_text(encoding='utf-8', errors='ignore')
for node in re.findall(r'<node\b[^>]*/?>', xml):
    text = html.unescape(re.search(r'text="([^"]*)"', node).group(1) if re.search(r'text="([^"]*)"', node) else '')
    desc = html.unescape(re.search(r'content-desc="([^"]*)"', node).group(1) if re.search(r'content-desc="([^"]*)"', node) else '')
    if needle not in (text, desc):
        continue
    match = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
    if not match:
        continue
    left, top, right, bottom = map(int, match.groups())
    print((left + right) // 2, (top + bottom) // 2)
    sys.exit(0)
sys.exit(1)
PY
}

tap_text() {
  local needle="$1"
  local coords
  coords="$(text_center "$needle")"
  adb shell input tap $coords
}

capture_png() {
  local remote="$1"
  local local_path="$2"
  adb shell screencap -p "$remote"
  timeout 20 adb pull "$remote" "$local_path" >/dev/null
}

record_screen() {
  local remote="$1"
  local local_path="$2"
  local seconds="${3:-6}"
  timeout $((seconds + 5)) adb shell screenrecord --time-limit "$seconds" "$remote" >/dev/null 2>&1 || true
  timeout 20 adb pull "$remote" "$local_path" >/dev/null 2>&1 || true
}

timeout 240 adb wait-for-device
for _ in $(seq 1 180); do
  boot_completed="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  [ "$boot_completed" = "1" ] && break
  sleep 1
done
adb shell wm size 1080x2400 || true
adb shell wm density 420 || true
adb shell settings put global window_animation_scale 0 || true
adb shell settings put global transition_animation_scale 0 || true
adb shell settings put global animator_duration_scale 0 || true

# Install and launch the production debug APK. This intentionally avoids AndroidScreenshotMode
# and exercises the app's real launcher shell route.
timeout 120 adb install -r "$APK" > proof-output/adb-install.log
adb shell am force-stop "$APP_ID" || true
timeout 30 adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 > proof-output/monkey-launch.log || true
wait_for_text "$SETTINGS_TEXT" 35
capture_png /sdcard/openclaw-01-launch.png proof-output/01-real-launch.png

tap_text "$SETTINGS_TEXT"
wait_for_text "$SKILL_WORKSHOP_TEXT" 25
capture_png /sdcard/openclaw-02-settings.png proof-output/02-settings-list.png
record_screen /sdcard/openclaw-settings-route.mp4 proof-output/skill-workshop-settings-route.mp4 4

tap_text "$SKILL_WORKSHOP_TEXT"
wait_for_text "Proposals" 25
capture_png /sdcard/openclaw-03-skill-workshop.png proof-output/03-skill-workshop-production-route.png
record_screen /sdcard/openclaw-skill-workshop-production.mp4 proof-output/skill-workshop-production-route.mp4 6

timeout 20 adb shell uiautomator dump /sdcard/openclaw-ui.xml >/dev/null 2>&1 || true
timeout 20 adb pull /sdcard/openclaw-ui.xml proof-output/openclaw-skill-workshop-ui.xml >/dev/null 2>&1 || true

python3 - <<'PY'
from pathlib import Path
xml = Path('proof-output/openclaw-skill-workshop-ui.xml').read_text(encoding='utf-8', errors='ignore')
required = ['Skill Workshop', 'Proposals', 'Pending', 'Held']
missing = [item for item in required if item not in xml]
if missing:
    raise SystemExit(f'Missing expected production Skill Workshop UI text: {missing}')
PY

{
  echo "target_commit=$(git rev-parse HEAD)"
  echo "apk=$APK"
  echo "runner=$(uname -a)"
  echo "proof_type=real GitHub Actions Android emulator capture"
  echo "route=production launcher shell -> Settings tab -> Skill Workshop row"
  echo "screenshot_mode=false"
  echo "media=03-skill-workshop-production-route.png, skill-workshop-production-route.mp4"
  echo "adb_devices:"; adb devices
  echo "captures:"; find proof-output -maxdepth 1 -type f -printf '%f\n' | sort
} > proof-output/proof-manifest.txt
