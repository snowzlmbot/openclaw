#!/usr/bin/env bash
set -euo pipefail

mkdir -p proof-output
: "${AVD_NAME:=OpenClaw_Skill_Workshop_API35}"
APP_ID="ai.openclaw.app"
SETTINGS_TEXT="Settings"
SKILL_WORKSHOP_TEXT="Skill Workshop"
GATEWAY_PORT="18789"
GATEWAY_DEVICE_HOST="10.0.2.2"
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
    echo "gateway_log_tail:"; tail -260 proof-output/gateway.log || true
    echo "emulator_log_tail:"; tail -220 proof-output/emulator.log || true
    echo "latest_ui_xml:"; cat proof-output/openclaw-ui.xml || true
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
  for _ in $(seq 1 90); do
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

start_real_gateway() {
  write_gateway_config
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
}

create_proposal() {
  local slug="$1"
  local title="$2"
  local description="$3"
  local draft_dir="proof-output/proposal-drafts/${slug}"
  mkdir -p "${draft_dir}/references"
  cat > "${draft_dir}/PROPOSAL.md" <<MD
# ${title}

${description}.

This pending proposal is created by \`openclaw skills workshop propose-create\` inside the same temporary proof state. The Android Settings > Skill Workshop screen must load it through the live Gateway and perform the lifecycle action from the mobile UI.
MD
  cat > "${draft_dir}/references/android-lifecycle-proof.md" <<MD
Support file for ${title}. It is inspected from the Android UI during the PR 101911 real lifecycle proof.
MD

  run_openclaw skills workshop propose-create \
    --name "${title}" \
    --description "${description}" \
    --proposal-dir "${draft_dir}" \
    --goal "Prove Android Skill Workshop ${slug} lifecycle against a live Gateway." \
    --evidence "Created inside snowzlmbot/openclaw GitHub Actions before Android emulator capture." \
    --json > "proof-output/cli-proposal-create-${slug}.json"

  python3 - "${slug}" <<'PY'
import json
import sys
from pathlib import Path
slug = sys.argv[1]
obj = json.loads(Path(f'proof-output/cli-proposal-create-{slug}.json').read_text())
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
    raise SystemExit(f'Could not parse created proposal id for {slug}')
Path(f'proof-output/proposal-{slug}-id.txt').write_text(ids[0] + '\n')
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
nodes = []
for node in re.findall(r'<node\b[^>]*/?>', xml):
    text_match = re.search(r'text="([^"]*)"', node)
    desc_match = re.search(r'content-desc="([^"]*)"', node)
    text = html.unescape(text_match.group(1) if text_match else '')
    desc = html.unescape(desc_match.group(1) if desc_match else '')
    bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
    if not bounds:
        continue
    left, top, right, bottom = map(int, bounds.groups())
    nodes.append((text, desc, (left + right) // 2, (top + bottom) // 2))
for text, desc, x, y in nodes:
    if text == needle or desc == needle:
        print(x, y)
        sys.exit(0)
for text, desc, x, y in nodes:
    if needle in text or needle in desc:
        print(x, y)
        sys.exit(0)
sys.exit(1)
PY
}

wait_for_tappable_text() {
  local needle="$1"
  local attempts="${2:-45}"
  for _ in $(seq 1 "${attempts}"); do
    copy_ui_xml proof-output/openclaw-ui.xml
    if text_center "$needle" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for tappable UI text: ${needle}" >&2
  return 1
}

tap_text() {
  local needle="$1"
  local fallback_coords="${2:-}"
  local coords=""
  copy_ui_xml proof-output/openclaw-ui.xml
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

record_action() {
  local remote="$1"
  local local_path="$2"
  local seconds="${3:-12}"
  timeout $((seconds + 8)) adb shell screenrecord --time-limit "$seconds" "$remote" >/dev/null 2>&1 &
  local rec_pid="$!"
  sleep 1
  printf '%s\n' "$rec_pid" > proof-output/current-recording-pid.txt
  printf '%s\n' "$remote" > proof-output/current-recording-remote.txt
  printf '%s\n' "$local_path" > proof-output/current-recording-local.txt
}

finish_record_action() {
  local rec_pid remote local_path
  rec_pid="$(cat proof-output/current-recording-pid.txt)"
  remote="$(cat proof-output/current-recording-remote.txt)"
  local_path="$(cat proof-output/current-recording-local.txt)"
  wait "$rec_pid" >/dev/null 2>&1 || true
  timeout 20 adb pull "$remote" "$local_path" >/dev/null 2>&1 || true
}

seed_app_prefs() {
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
}

launch_app_shell() {
  adb shell am force-stop "$APP_ID" || true
  timeout 30 adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 > "proof-output/monkey-launch-${1}.log" || true
  wait_for_text "$SETTINGS_TEXT" 90
  if wait_for_text "Reconnect gateway" 8; then
    tap_text "Reconnect gateway" "570 1070" || true
    sleep 8
  fi
}

open_skill_workshop_detail() {
  local slug="$1"
  local title="$2"
  local description="$3"
  tap_text "$SETTINGS_TEXT" "945 2290"
  wait_for_text "$SKILL_WORKSHOP_TEXT" 60
  capture_png "/sdcard/openclaw-${slug}-settings.png" "proof-output/${slug}-01-settings.png"
  copy_ui_xml "proof-output/${slug}-01-settings-ui.xml"
  tap_text "$SKILL_WORKSHOP_TEXT"
  wait_for_text "$title" 120
  capture_png "/sdcard/openclaw-${slug}-list.png" "proof-output/${slug}-02-pending-list.png"
  copy_ui_xml "proof-output/${slug}-02-pending-list-ui.xml"
  tap_text "Open"
  wait_for_text "$description" 120
  adb shell input swipe 540 2100 540 650 650 || true
  wait_for_tappable_text "Apply" 60
  wait_for_tappable_text "Reject" 60
  wait_for_tappable_text "Quarantine" 60
  capture_png "/sdcard/openclaw-${slug}-detail-before-action.png" "proof-output/${slug}-03-detail-before-action.png"
  copy_ui_xml "proof-output/${slug}-03-detail-before-action-ui.xml"
}

perform_lifecycle_action() {
  local slug="$1"
  local title="$2"
  local description="$3"
  local action="$4"
  local past="$5"
  local notice="Proposal ${past}."
  launch_app_shell "$slug"
  open_skill_workshop_detail "$slug" "$title" "$description"
  record_action "/sdcard/openclaw-${slug}-${action,,}.mp4" "proof-output/${slug}-04-${action,,}-action.mp4" 14
  tap_text "$action"
  wait_for_text "${action} proposal?" 45
  capture_png "/sdcard/openclaw-${slug}-${action,,}-confirm.png" "proof-output/${slug}-04-${action,,}-confirm-dialog.png"
  copy_ui_xml "proof-output/${slug}-04-${action,,}-confirm-dialog-ui.xml"
  tap_text "$action"
  wait_for_text "$notice" 120
  finish_record_action
  capture_png "/sdcard/openclaw-${slug}-${action,,}-complete.png" "proof-output/${slug}-05-${action,,}-complete.png"
  copy_ui_xml "proof-output/${slug}-05-${action,,}-complete-ui.xml"
}

start_real_gateway

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

timeout 120 adb install -r "$APK" > proof-output/adb-install.log
seed_app_prefs

create_proposal "reject-proof" "Reject Proof Mobile Skill" "Android real Gateway lifecycle rejection proof for PR 101911"
perform_lifecycle_action "reject-proof" "Reject Proof Mobile Skill" "Android real Gateway lifecycle rejection proof for PR 101911" "Reject" "rejected"

create_proposal "apply-proof" "Apply Proof Mobile Skill" "Android real Gateway lifecycle approval proof for PR 101911"
perform_lifecycle_action "apply-proof" "Apply Proof Mobile Skill" "Android real Gateway lifecycle approval proof for PR 101911" "Apply" "applied"

run_openclaw_gateway_call skills.proposals.list \
  --params '{}' \
  --timeout 20000 \
  --json > proof-output/gateway-proposals-list-after-actions.json

python3 - <<'PY'
import json
from pathlib import Path
reject_id = Path('proof-output/proposal-reject-proof-id.txt').read_text().strip()
apply_id = Path('proof-output/proposal-apply-proof-id.txt').read_text().strip()
list_text = Path('proof-output/gateway-proposals-list-after-actions.json').read_text()
ui_text = '\n'.join(p.read_text(encoding='utf-8', errors='ignore') for p in Path('proof-output').glob('*-ui.xml'))
required_ui = [
    'Reject Proof Mobile Skill',
    'Reject proposal?',
    'Proposal rejected.',
    'Apply Proof Mobile Skill',
    'Apply proposal?',
    'Proposal applied.',
    'Apply',
    'Reject',
    'Quarantine',
]
missing_ui = [item for item in required_ui if item not in ui_text]
if missing_ui:
    raise SystemExit(f'Missing expected Android UI lifecycle proof text: {missing_ui}')
obj = json.loads(list_text)
statuses = {}
def walk(value):
    if isinstance(value, dict):
        if isinstance(value.get('id'), str) and isinstance(value.get('status'), str):
            statuses[value['id']] = value['status']
        for item in value.values():
            walk(item)
    elif isinstance(value, list):
        for item in value:
            walk(item)
walk(obj)
expected = {reject_id: 'rejected', apply_id: 'applied'}
missing = {pid: status for pid, status in expected.items() if statuses.get(pid) != status}
if missing:
    raise SystemExit(f'Gateway lifecycle statuses did not match: expected {missing}, got {statuses}')
PY

expected_head=""
if [ -f scripts/proof/pr101911-expected-head.txt ]; then
  expected_head="$(tr -d '[:space:]' < scripts/proof/pr101911-expected-head.txt)"
fi
{
  echo "target_commit=$(git rev-parse HEAD)"
  [ -n "$expected_head" ] && echo "expected_pr_head=${expected_head}"
  echo "reject_proposal_id=$(tr -d '[:space:]' < proof-output/proposal-reject-proof-id.txt)"
  echo "apply_proposal_id=$(tr -d '[:space:]' < proof-output/proposal-apply-proof-id.txt)"
  echo "apk=$APK"
  echo "runner=$(uname -a)"
  echo "proof_type=real GitHub Actions Android emulator capture against a temporary real OpenClaw Gateway"
  echo "route=launcher -> completed-onboarding app shell -> Settings tab -> Skill Workshop row -> real Gateway pending proposal -> inspect detail -> Android confirm dialog -> live reject/apply mutation -> Gateway list status verification"
  echo "preseeded_state=onboarding.completed=true and manual loopback gateway endpoint only"
  echo "gateway_auth=auth none on loopback-only temporary proof Gateway"
  echo "gateway_rpc=health, skills.proposals.list, skills.proposals.inspect via Android runtime, skills.proposals.reject/apply via Android runtime, post-action list verification"
  echo "proposal_create=cli skills workshop propose-create against the same temporary proof state"
  echo "screenshot_mode=false"
  echo "media=reject-proof-04-reject-confirm-dialog.png, reject-proof-05-reject-complete.png, apply-proof-04-apply-confirm-dialog.png, apply-proof-05-apply-complete.png, reject/apply action mp4 recordings"
  echo "logs=gateway.log, cli-proposal-create-*.json, gateway-proposals-list-after-actions.json"
  echo "adb_devices:"; adb devices
  echo "captures:"; find proof-output -maxdepth 1 -type f -printf '%f\n' | sort
} > proof-output/proof-manifest.txt
