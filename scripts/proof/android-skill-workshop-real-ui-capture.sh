#!/usr/bin/env bash
set -euo pipefail

mkdir -p proof-output
: "${AVD_NAME:=OpenClaw_Skill_Workshop_API35}"
APP_ID="ai.openclaw.app"
SETTINGS_TEXT="Settings"
SKILL_WORKSHOP_TEXT="Skill Workshop"
PROPOSAL_TITLE="Create Proof Mobile Skill"
PROPOSAL_DETAIL_TEXT="Android real Gateway media proof"
GATEWAY_PORT="18789"
GATEWAY_DEVICE_HOST="10.0.2.2"
GATEWAY_URL="ws://127.0.0.1:${GATEWAY_PORT}"
STATE_DIR="$(pwd)/proof-output/openclaw-state"
CONFIG_PATH="$(pwd)/proof-output/openclaw-proof-config.json"
GATEWAY_PID=""
EMU_PID=""

APK="$(find apps/android/app/build/outputs/apk/play/debug -maxdepth 1 -type f -name '*.apk' | sort | head -n 1)"
if [ -z "${APK}" ] || [ ! -f "${APK}" ]; then
  echo "No Play debug APK found under apps/android/app/build/outputs/apk/play/debug" >&2
  exit 1
fi
printf '%s\n' "${APK}" > proof-output/apk-path.txt

cleanup() {
  if [ -n "${GATEWAY_PID}" ]; then
    kill "${GATEWAY_PID}" >/dev/null 2>&1 || true
    wait "${GATEWAY_PID}" >/dev/null 2>&1 || true
  fi
  timeout 5 adb emu kill >/dev/null 2>&1 || true
  if [ -n "${EMU_PID}" ]; then
    wait "${EMU_PID}" >/dev/null 2>&1 || true
  fi
}

dump_debug() {
  local exit_code="$?"
  {
    echo "capture_exit_code=${exit_code}"
    echo "gateway_pid=${GATEWAY_PID:-unset}"
    [ -n "${GATEWAY_PID}" ] && ps -fp "${GATEWAY_PID}" || true
    echo "emulator_pid=${EMU_PID:-unset}"
    [ -n "${EMU_PID}" ] && ps -fp "${EMU_PID}" || true
    echo "adb_devices:"; adb devices || true
    echo "gateway_log_tail:"; tail -240 proof-output/gateway.log || true
    echo "emulator_log_tail:"; tail -200 proof-output/emulator.log || true
  } > proof-output/capture-debug.txt 2>&1
  cat proof-output/capture-debug.txt >&2 || true
  exit "${exit_code}"
}
trap dump_debug ERR
trap cleanup EXIT

run_openclaw() {
  OPENCLAW_STATE_DIR="${STATE_DIR}" \
  OPENCLAW_CONFIG_PATH="${CONFIG_PATH}" \
  OPENCLAW_SKIP_CHANNELS=1 \
  NODE_DISABLE_COMPILE_CACHE=1 \
  node openclaw.mjs "$@"
}

write_gateway_config() {
  mkdir -p "${STATE_DIR}"
  cat > "${CONFIG_PATH}" <<JSON
{
  "gateway": {
    "mode": "local",
    "port": ${GATEWAY_PORT},
    "bind": "loopback",
    "auth": { "mode": "none" }
  }
}
JSON
}

run_openclaw_gateway_call() {
  run_openclaw gateway call "$@"
}

wait_for_gateway() {
  for attempt in $(seq 1 90); do
    if run_openclaw_gateway_call health --timeout 5000 --json > proof-output/gateway-health.json 2> proof-output/gateway-health.err; then
      return 0
    fi
    if [ -n "${GATEWAY_PID}" ] && ! kill -0 "${GATEWAY_PID}" >/dev/null 2>&1; then
      echo "Gateway exited before becoming healthy" >&2
      return 1
    fi
    sleep 1
  done
  echo "Timed out waiting for Gateway health" >&2
  return 1
}

start_real_gateway_and_seed_proposal() {
  write_gateway_config

  mkdir -p proof-output/proposal-draft/references
  cat > proof-output/proposal-draft/PROPOSAL.md <<'MD'
# Proof Mobile Skill

Android real Gateway media proof for PR 101911.

This pending proposal is created by `openclaw skills workshop propose-create` inside the same temporary proof state. The Android Settings > Skill Workshop screen then loads it through the live Gateway `skills.proposals.list` and `skills.proposals.inspect` read paths.
MD
  cat > proof-output/proposal-draft/references/android-proof.md <<'MD'
This support file is created by the real proof workflow and inspected from the Android UI.
MD

  run_openclaw skills workshop propose-create \
    --name "Proof Mobile Skill" \
    --description "Android real Gateway media proof for PR 101911" \
    --proposal-dir proof-output/proposal-draft \
    --goal "Prove the Android Settings Skill Workshop list and inspect flow against a live Gateway." \
    --evidence "Created inside snowzlmbot/openclaw GitHub Actions before Android emulator capture." \
    --json > proof-output/cli-proposal-create.json

  python3 - <<'PY'
import json
from pathlib import Path
obj = json.loads(Path('proof-output/cli-proposal-create.json').read_text())
ids = []

def walk(value):
    if isinstance(value, dict):
        rec = value.get('record')
        if isinstance(rec, dict) and isinstance(rec.get('id'), str):
            ids.append(rec['id'])
        if isinstance(value.get('id'), str) and value.get('status'):
            ids.append(value['id'])
        for item in value.values():
            walk(item)
    elif isinstance(value, list):
        for item in value:
            walk(item)
walk(obj)
if not ids:
    raise SystemExit('Could not parse created proposal id from cli-proposal-create.json')
Path('proof-output/proposal-id.txt').write_text(ids[0] + '\n')
PY
  local proposal_id
  proposal_id="$(tr -d '[:space:]' < proof-output/proposal-id.txt)"

  run_openclaw gateway run \
    --port "${GATEWAY_PORT}" \
    --bind loopback \
    --auth none \
    --allow-unconfigured \
    --force \
    --compact \
    --cli-backend-logs \
    > proof-output/gateway.log 2>&1 &
  GATEWAY_PID="$!"
  wait_for_gateway

  run_openclaw_gateway_call skills.proposals.list \
    --params '{}' \
    --timeout 20000 \
    --json > proof-output/gateway-proposals-list.json

  run_openclaw_gateway_call skills.proposals.inspect \
    --params "{\"proposalId\":\"${proposal_id}\"}" \
    --timeout 20000 \
    --json > proof-output/gateway-proposal-inspect.json

  python3 - <<'PY'
from pathlib import Path
needles = ['Proof Mobile Skill', 'references/android-proof.md']
combined = '\n'.join(Path(p).read_text(encoding='utf-8', errors='ignore') for p in [
    'proof-output/cli-proposal-create.json',
    'proof-output/gateway-proposals-list.json',
    'proof-output/gateway-proposal-inspect.json',
])
missing = [n for n in needles if n not in combined]
if missing:
    raise SystemExit(f'Missing expected Gateway proposal proof output: {missing}')
PY
}
wait_for_text() {
  local needle="$1"
  local attempts="${2:-45}"
  local out="proof-output/openclaw-ui.xml"
  for _ in $(seq 1 "${attempts}"); do
    timeout 20 adb shell uiautomator dump /sdcard/openclaw-ui.xml >/dev/null 2>&1 || true
    timeout 20 adb pull /sdcard/openclaw-ui.xml "${out}" >/dev/null 2>&1 || true
    if [ -f "${out}" ] && grep -Fq "${needle}" "${out}"; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for UI text: ${needle}" >&2
  return 1
}

copy_ui_xml() {
  local local_path="$1"
  timeout 20 adb shell uiautomator dump /sdcard/openclaw-ui.xml >/dev/null 2>&1 || true
  timeout 20 adb pull /sdcard/openclaw-ui.xml "${local_path}" >/dev/null 2>&1 || true
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
    if needle not in text and needle not in desc:
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
  echo "Could not find tappable UI text: ${needle}" >&2
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

start_real_gateway_and_seed_proposal

emulator -avd "$AVD_NAME" -no-window -no-snapshot -no-snapshot-save -no-audio -no-boot-anim -gpu swiftshader_indirect -memory 2048 -cores 2 > proof-output/emulator.log 2>&1 &
EMU_PID="$!"

sleep 15
if ! kill -0 "$EMU_PID" >/dev/null 2>&1; then
  echo "Emulator process exited before adb wait-for-device" >&2
  false
fi

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

# Seed only completed onboarding plus a manual loopback Gateway endpoint. Proposal data still comes
# from the live OpenClaw Gateway through WebSocket RPC, not from app-side UI fixtures.
cat > proof-output/openclaw.node.xml <<XML
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
  <boolean name="onboarding.completed" value="true" />
  <boolean name="gateway.manual.enabled" value="true" />
  <string name="gateway.manual.host">${GATEWAY_DEVICE_HOST}</string>
  <int name="gateway.manual.port" value="${GATEWAY_PORT}" />
  <boolean name="gateway.manual.tls" value="false" />
</map>
XML
adb push proof-output/openclaw.node.xml /data/local/tmp/openclaw.node.xml >/dev/null
adb shell chmod 644 /data/local/tmp/openclaw.node.xml >/dev/null 2>&1 || true
adb shell run-as "$APP_ID" mkdir -p shared_prefs
adb shell run-as "$APP_ID" cp /data/local/tmp/openclaw.node.xml shared_prefs/openclaw.node.xml

# Launch through the normal launcher entry point. ScreenshotMode is intentionally not used.
adb shell am force-stop "$APP_ID" || true
timeout 30 adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 > proof-output/monkey-launch.log || true
wait_for_text "$SETTINGS_TEXT" 90
if wait_for_text "Reconnect gateway" 8; then
  tap_text "Reconnect gateway" "570 1070" || true
  sleep 8
fi
capture_png /sdcard/openclaw-01-launch.png proof-output/01-real-launch-connected-gateway.png
copy_ui_xml proof-output/01-launch-ui.xml

# Navigate through the production bottom navigation to Settings, then into the Skill Workshop row.
tap_text "$SETTINGS_TEXT" "945 2290"
wait_for_text "$SKILL_WORKSHOP_TEXT" 60
capture_png /sdcard/openclaw-02-settings-list.png proof-output/02-settings-list.png
copy_ui_xml proof-output/02-settings-list-ui.xml
record_screen /sdcard/openclaw-settings-list.mp4 proof-output/settings-list.mp4 4

tap_text "$SKILL_WORKSHOP_TEXT"
wait_for_text "$PROPOSAL_TITLE" 120
capture_png /sdcard/openclaw-03-skill-workshop-list.png proof-output/03-real-gateway-proposal-list.png
copy_ui_xml proof-output/03-skill-workshop-list-ui.xml
record_screen /sdcard/openclaw-skill-workshop-list.mp4 proof-output/skill-workshop-real-gateway-list.mp4 6

# Open the proposal detail. Selecting the real proposal triggers skills.proposals.inspect in the app runtime.
tap_text "Open" || tap_text "$PROPOSAL_TITLE" "300 1545" || true
adb shell input swipe 540 2100 540 660 650 || true
wait_for_text "$PROPOSAL_DETAIL_TEXT" 120
capture_png /sdcard/openclaw-04-skill-workshop-detail.png proof-output/04-real-gateway-proposal-detail.png
copy_ui_xml proof-output/04-skill-workshop-detail-ui.xml

# Scroll to the lifecycle action controls and capture the admin-gated action area.
adb shell input swipe 540 2100 540 650 650 || true
wait_for_text "Quarantine" 60
capture_png /sdcard/openclaw-05-skill-workshop-actions.png proof-output/05-skill-workshop-admin-actions.png
copy_ui_xml proof-output/05-skill-workshop-actions-ui.xml
record_screen /sdcard/openclaw-skill-workshop-actions.mp4 proof-output/skill-workshop-admin-actions.mp4 6

python3 - <<'PY'
from pathlib import Path
xml_paths = [
    'proof-output/03-skill-workshop-list-ui.xml',
    'proof-output/04-skill-workshop-detail-ui.xml',
    'proof-output/05-skill-workshop-actions-ui.xml',
]
xml = '\n'.join(Path(p).read_text(encoding='utf-8', errors='ignore') for p in xml_paths if Path(p).exists())
required = [
    'Skill Workshop',
    'Proof Mobile Skill',
    'Android real Gateway media proof',
    'references/android-proof.md',
    'Inspect',
    'Apply',
    'Reject',
    'Quarantine',
]
missing = [item for item in required if item not in xml]
if missing:
    raise SystemExit(f'Missing expected real Gateway Skill Workshop UI text: {missing}')
PY

expected_head=""
if [ -f scripts/proof/pr101911-expected-head.txt ]; then
  expected_head="$(tr -d '[:space:]' < scripts/proof/pr101911-expected-head.txt)"
fi
{
  echo "target_commit=$(git rev-parse HEAD)"
  [ -n "$expected_head" ] && echo "expected_pr_head=${expected_head}"
  echo "created_proposal_id=$(tr -d '[:space:]' < proof-output/proposal-id.txt)"
  echo "apk=$APK"
  echo "runner=$(uname -a)"
  echo "proof_type=real GitHub Actions Android emulator capture against a temporary real OpenClaw Gateway"
  echo "route=launcher -> completed-onboarding app shell -> Settings tab -> Skill Workshop row -> real Gateway proposal list -> inspect detail -> admin action controls"
  echo "preseeded_state=onboarding.completed=true and manual loopback gateway endpoint only"
  echo "gateway_auth=auth none on loopback-only temporary proof Gateway"
  echo "gateway_rpc=health, skills.proposals.list, skills.proposals.inspect"
  echo "proposal_create=cli skills workshop propose-create against the same temporary proof state"
  echo "screenshot_mode=false"
  echo "media=03-real-gateway-proposal-list.png, 04-real-gateway-proposal-detail.png, 05-skill-workshop-admin-actions.png"
  echo "logs=gateway.log, cli-proposal-create.json, gateway-proposals-list.json, gateway-proposal-inspect.json"
  echo "adb_devices:"; adb devices
  echo "captures:"; find proof-output -maxdepth 1 -type f -printf '%f\n' | sort
} > proof-output/proof-manifest.txt
