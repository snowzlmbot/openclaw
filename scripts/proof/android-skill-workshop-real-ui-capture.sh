#!/usr/bin/env bash
set -euo pipefail

mkdir -p proof-output
: "${AVD_NAME:=OpenClaw_Skill_Workshop_API35}"
APP_ID="ai.openclaw.app"
SETTINGS_TEXT="Settings"
SKILL_WORKSHOP_TEXT="Skill Workshop"
APK="$(find apps/android/app/build/outputs/apk/play/debug -maxdepth 1 -type f -name '*.apk' | sort | head -n 1)"
if [ -z "${APK}" ] || [ ! -f "${APK}" ]; then
  echo "No Play debug APK found under apps/android/app/build/outputs/apk/play/debug" >&2
  exit 1
fi
printf '%s\n' "${APK}" > proof-output/apk-path.txt

emulator -avd "$AVD_NAME" -no-window -no-snapshot -no-snapshot-save -no-audio -no-boot-anim -gpu swiftshader_indirect -memory 2048 -cores 2 > proof-output/emulator.log 2>&1 &
EMU_PID=$!
cleanup() {
  timeout 5 adb emu kill >/dev/null 2>&1 || true
  wait "$EMU_PID" >/dev/null 2>&1 || true
}
dump_emulator_debug() {
  local exit_code="$?"
  {
    echo "capture_exit_code=${exit_code}"
    echo "emulator_pid=${EMU_PID}"
    ps -fp "$EMU_PID" || true
    echo "adb_devices:"; adb devices || true
    echo "emulator_log_tail:"; tail -200 proof-output/emulator.log || true
  } > proof-output/capture-debug.txt 2>&1
  cat proof-output/capture-debug.txt >&2 || true
  exit "$exit_code"
}
trap dump_emulator_debug ERR
trap cleanup EXIT

sleep 15
if ! kill -0 "$EMU_PID" >/dev/null 2>&1; then
  echo "Emulator process exited before adb wait-for-device" >&2
  false
fi

wait_for_text() {
  local needle="$1"
  local attempts="${2:-45}"
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
    text_match = re.search(r'text="([^"]*)"', node)
    desc_match = re.search(r'content-desc="([^"]*)"', node)
    text = html.unescape(text_match.group(1) if text_match else '')
    desc = html.unescape(desc_match.group(1) if desc_match else '')
    if needle not in (text, desc):
        continue
    bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
    if not bounds:
        continue
    left, top, right, bottom = map(int, bounds.groups())
    print((left + right) // 2, (top + bottom) // 2)
    sys.exit(0)
sys.exit(1)
PY
}

tap_text() {
  local needle="$1"
  local fallback_coords="${2:-}"
  local coords=""
  if coords="$(text_center "$needle" 2>/dev/null)" && [ -n "$coords" ]; then
    adb shell input tap $coords
    return 0
  fi
  if [ -n "$fallback_coords" ]; then
    adb shell input tap $fallback_coords
    return 0
  fi
  echo "Could not find tappable UI text: $needle" >&2
  return 1
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
  timeout $((seconds + 8)) adb shell screenrecord --time-limit "$seconds" "$remote" >/dev/null 2>&1 || true
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

# Install the actual Play debug APK produced by the current repository head.
timeout 120 adb install -r "$APK" > proof-output/adb-install.log

# Seed only the same non-secret onboarding preference the app writes after setup,
# so the capture can exercise the production Settings shell without connecting a private Gateway.
cat > proof-output/openclaw.node.xml <<'XML'
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
  <boolean name="onboarding.completed" value="true" />
</map>
XML
adb push proof-output/openclaw.node.xml /data/local/tmp/openclaw.node.xml >/dev/null
adb shell chmod 644 /data/local/tmp/openclaw.node.xml >/dev/null 2>&1 || true
adb shell run-as "$APP_ID" mkdir -p shared_prefs
adb shell run-as "$APP_ID" cp /data/local/tmp/openclaw.node.xml shared_prefs/openclaw.node.xml

# Launch through the normal launcher entry point. ScreenshotMode is intentionally not used.
adb shell am force-stop "$APP_ID" || true
timeout 30 adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 > proof-output/monkey-launch.log || true
wait_for_text "$SETTINGS_TEXT" 70
capture_png /sdcard/openclaw-01-launch.png proof-output/01-real-launch.png

# Navigate through the production bottom navigation to Settings, then into the Skill Workshop row.
tap_text "$SETTINGS_TEXT" "945 2290"
wait_for_text "$SKILL_WORKSHOP_TEXT" 45
capture_png /sdcard/openclaw-02-settings-list.png proof-output/02-settings-list.png
record_screen /sdcard/openclaw-settings-list.mp4 proof-output/settings-list.mp4 4

tap_text "$SKILL_WORKSHOP_TEXT"
wait_for_text "Gateway offline" 45
capture_png /sdcard/openclaw-03-skill-workshop.png proof-output/03-skill-workshop-production-route.png
record_screen /sdcard/openclaw-skill-workshop-production.mp4 proof-output/skill-workshop-production-route.mp4 6

timeout 20 adb shell uiautomator dump /sdcard/openclaw-ui.xml >/dev/null 2>&1 || true
timeout 20 adb pull /sdcard/openclaw-ui.xml proof-output/openclaw-skill-workshop-ui.xml >/dev/null 2>&1 || true

python3 - <<'PY'
from pathlib import Path
xml = Path('proof-output/openclaw-skill-workshop-ui.xml').read_text(encoding='utf-8', errors='ignore')
required = ['Skill Workshop', 'Pending', 'Held', 'Applied', 'Rejected', 'Gateway offline']
missing = [item for item in required if item not in xml]
if missing:
    raise SystemExit(f'Missing expected production Skill Workshop UI text: {missing}')
PY

expected_head=""
if [ -f scripts/proof/pr101911-expected-head.txt ]; then
  expected_head="$(tr -d '[:space:]' < scripts/proof/pr101911-expected-head.txt)"
fi
{
  echo "target_commit=$(git rev-parse HEAD)"
  [ -n "$expected_head" ] && echo "expected_pr_head=${expected_head}"
  echo "apk=$APK"
  echo "runner=$(uname -a)"
  echo "proof_type=real GitHub Actions Android emulator capture"
  echo "route=launcher -> completed-onboarding app shell -> Settings tab -> Skill Workshop row"
  echo "preseeded_state=onboarding.completed=true only"
  echo "screenshot_mode=false"
  echo "media=03-skill-workshop-production-route.png, skill-workshop-production-route.mp4"
  echo "adb_devices:"; adb devices
  echo "captures:"; find proof-output -maxdepth 1 -type f -printf '%f\n' | sort
} > proof-output/proof-manifest.txt
