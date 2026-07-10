#!/usr/bin/env bash
set -euo pipefail

mkdir -p proof-output
: "${AVD_NAME:=OpenClaw_ClawHub_Skills_API35}"
APP_ID="ai.openclaw.app"
SETTINGS_TEXT="Settings"
SKILLS_TEXT="Skills"
CLAW_HUB_TEXT="ClawHub"
PROOF_SKILL_TITLE="Proof Clean Skill"
WARNING_SKILL_TITLE="Proof Warning Skill"
BLOCKED_SKILL_TITLE="Proof Blocked Skill"
REVIEW_TITLE="Review ClawHub audit"
GATEWAY_PORT="18789"
CLAW_HUB_PORT="18880"
GATEWAY_DEVICE_HOST="10.0.2.2"
STATE_DIR="$(pwd)/proof-output/openclaw-state"
CONFIG_PATH="$(pwd)/proof-output/openclaw-proof-config.json"
LIMITED_OPERATOR_SCOPES='["operator.approvals","operator.read","operator.talk.secrets","operator.write"]'
GATEWAY_PID=""
CLAW_HUB_PID=""
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
  if [ -n "${CLAW_HUB_PID}" ]; then
    kill "${CLAW_HUB_PID}" >/dev/null 2>&1 || true
    wait "${CLAW_HUB_PID}" >/dev/null 2>&1 || true
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
    echo "clawhub_pid=${CLAW_HUB_PID:-unset}"
    [ -n "${CLAW_HUB_PID}" ] && ps -fp "${CLAW_HUB_PID}" || true
    echo "emulator_pid=${EMU_PID:-unset}"
    [ -n "${EMU_PID}" ] && ps -fp "${EMU_PID}" || true
    echo "adb_devices:"; adb devices || true
    echo "gateway_log_tail:"; tail -240 proof-output/gateway.log || true
    echo "clawhub_log_tail:"; tail -200 proof-output/clawhub-mock.log || true
    echo "emulator_log_tail:"; tail -200 proof-output/emulator.log || true
    echo "capture_log_tail:"; tail -200 proof-output/capture.log || true
  } > proof-output/capture-debug.txt 2>&1
  cat proof-output/capture-debug.txt >&2 || true
  exit "${exit_code}"
}
trap dump_debug ERR
trap cleanup EXIT

run_openclaw() {
  OPENCLAW_STATE_DIR="${STATE_DIR}" \
  OPENCLAW_CONFIG_PATH="${CONFIG_PATH}" \
  OPENCLAW_CLAWHUB_URL="http://127.0.0.1:${CLAW_HUB_PORT}" \
  OPENCLAW_SKIP_CHANNELS=1 \
  NODE_DISABLE_COMPILE_CACHE=1 \
  node openclaw.mjs "$@"
}

run_openclaw_gateway_call() {
  run_openclaw gateway call "$@"
}

gateway_call_capture() {
  local method="$1"
  local params="$2"
  local output_name="$3"
  run_openclaw_gateway_call "${method}" \
    --params "${params}" \
    --timeout 120000 \
    --json > "proof-output/${output_name}.json" 2> "proof-output/${output_name}.err" || true
  python3 - "${method}" "${params}" "proof-output/${output_name}.json" >> proof-output/gateway-rpc-events.jsonl <<'PY'
import json
import sys
import time
from pathlib import Path

method, params, path = sys.argv[1], sys.argv[2], Path(sys.argv[3])
try:
    response = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    response = path.read_text(encoding="utf-8", errors="ignore")
print(json.dumps({
    "ts": time.time(),
    "method": method,
    "params": json.loads(params),
    "response": response,
}, sort_keys=True))
PY
}

restrict_pending_pairing_scopes() {
  local request_id="$1"
  local pending_path="${STATE_DIR}/devices/pending.json"
  python3 - "${pending_path}" "${request_id}" "${LIMITED_OPERATOR_SCOPES}" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
request_id = sys.argv[2]
limited_scopes = json.loads(sys.argv[3])
data = json.loads(path.read_text(encoding="utf-8"))
item = data.get(request_id)
if not isinstance(item, dict):
    raise SystemExit(f"pending request not found: {request_id}")
item["scopes"] = limited_scopes
path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
PY
}

write_device_pair_list_snapshot() {
  local output_path="$1"
  local pending_path="${STATE_DIR}/devices/pending.json"
  local paired_path="${STATE_DIR}/devices/paired.json"
  python3 - "${pending_path}" "${paired_path}" "${output_path}" <<'PY'
import json
import sys
from pathlib import Path

pending_path = Path(sys.argv[1])
paired_path = Path(sys.argv[2])
output_path = Path(sys.argv[3])

def load_values(path):
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if isinstance(data, dict):
        return list(data.values())
    if isinstance(data, list):
        return data
    return []

output_path.write_text(
    json.dumps(
        {"pending": load_values(pending_path), "paired": load_values(paired_path)},
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ),
    encoding="utf-8",
)
PY
}

select_android_pending_request_ids() {
  local input_path="$1"
  python3 - "${input_path}" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
pending = data.get("pending") if isinstance(data, dict) else []
for item in pending or []:
    fields = " ".join(
        str(item.get(key) or "").lower()
        for key in ("platform", "deviceFamily", "clientId", "displayName")
    )
    if "android" not in fields and "openclaw-android" not in fields:
        continue
    request_id = str(item.get("requestId") or "").strip()
    if request_id:
        print(request_id)
PY
}

approve_pairing_direct_from_state() {
  local request_id="$1"
  local output_path="$2"
  node --import tsx --input-type=module - "${request_id}" "${STATE_DIR}" > "${output_path}" <<'JS'
import { approveDevicePairing } from './src/infra/device-pairing.ts';

const [, , requestId, stateDir] = process.argv;
const result = await approveDevicePairing(
  requestId,
  { callerScopes: ['operator.admin'], approvedVia: 'owner' },
  stateDir,
);
if (!result || result.status !== 'approved') {
  console.error(JSON.stringify({ requestId, result }, null, 2));
  process.exit(1);
}
const { tokens, ...device } = result.device;
console.log(JSON.stringify({ requestId: result.requestId, device }, null, 2));
JS
}

redact_json_file() {
  local input_path="$1"
  local output_path="$2"
  python3 - "$input_path" "$output_path" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dest = Path(sys.argv[2])

try:
    data = json.loads(src.read_text(encoding="utf-8"))
except Exception:
    dest.write_text(src.read_text(encoding="utf-8", errors="ignore"), encoding="utf-8")
    raise SystemExit(0)

def redact(value):
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            if "token" in str(key).lower() or "secret" in str(key).lower():
                result[key] = "<redacted>"
            else:
                result[key] = redact(child)
        return result
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value

dest.write_text(json.dumps(redact(data), ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
PY
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

start_clawhub_fixture() {
  local root_dir
  root_dir="$(pwd)"
  rm -f proof-output/proof-clean-skill.zip proof-output/proof-warning-skill.zip
  for skill_slug in proof-clean-skill proof-warning-skill; do
    skill_title="Proof Clean Skill"
    [ "${skill_slug}" = "proof-warning-skill" ] && skill_title="Proof Warning Skill"
    tmp_dir="$(mktemp -d)"
    mkdir -p "${tmp_dir}/${skill_slug}"
    cat > "${tmp_dir}/${skill_slug}/SKILL.md" <<EOF_SKILL
---
name: ${skill_slug}
description: Android ClawHub proof fixture installed by the real media proof workflow.
---

# ${skill_title}

This deterministic fixture is installed only inside the PR proof workflow.
EOF_SKILL
    (cd "${tmp_dir}" && zip -qr "${root_dir}/proof-output/${skill_slug}.zip" "${skill_slug}")
    rm -rf "${tmp_dir}"
  done

  cat > proof-output/clawhub-fixture-server.py <<'PY'
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 18880
LOG = "proof-output/clawhub-fixture.jsonl"
SKILLS = {
    "proof-clean-skill": {
        "slug": "proof-clean-skill",
        "displayName": "Proof Clean Skill",
        "summary": "Clean install proof fixture for Android media proof.",
        "version": "1.2.3",
        "ownerHandle": "openclaw",
        "safety": "clean",
        "zipPath": "proof-output/proof-clean-skill.zip",
    },
    "proof-warning-skill": {
        "slug": "proof-warning-skill",
        "displayName": "Proof Warning Skill",
        "summary": "Review-required proof fixture for Android media proof.",
        "version": "2.0.0",
        "ownerHandle": "openclaw",
        "safety": "suspicious",
        "zipPath": "proof-output/proof-warning-skill.zip",
    },
    "proof-blocked-skill": {
        "slug": "proof-blocked-skill",
        "displayName": "Proof Blocked Skill",
        "summary": "Blocked proof fixture for Android media proof.",
        "version": "9.9.9",
        "ownerHandle": "openclaw",
        "safety": "malicious",
        "zipPath": None,
    },
}

def skill_summary(skill):
    return {
        "slug": skill["slug"],
        "displayName": skill["displayName"],
        "summary": skill["summary"],
        "version": skill["version"],
        "ownerHandle": skill["ownerHandle"],
    }

def skill_detail(skill):
    return {
        "skill": {
            "slug": skill["slug"],
            "displayName": skill["displayName"],
            "summary": skill["summary"],
            "description": f"{skill['displayName']} used to capture Android ClawHub behavior proof.",
            "topics": ["proof", "android", "clawhub"],
            "tags": {"latest": skill["version"]},
            "stats": {"downloads": 42, "installs": 7, "versions": 1},
            "createdAt": 1700000000000,
            "updatedAt": 1700000000000,
        },
        "owner": {
            "handle": skill["ownerHandle"],
            "displayName": "OpenClaw Proof",
            "image": "https://example.invalid/openclaw-proof.png",
        },
        "latestVersion": {
            "version": skill["version"],
            "createdAt": 1700000000000,
            "changelog": "Proof release for Android media capture.",
            "license": "MIT",
        },
    }

def verdict(skill, requested):
    status = skill["safety"]
    base = {
        "requestedSlug": requested.get("slug"),
        "requestedVersion": requested.get("version"),
        "slug": skill["slug"],
        "version": skill["version"],
        "displayName": skill["displayName"],
        "publisherHandle": skill["ownerHandle"],
        "publisherDisplayName": "OpenClaw Proof",
        "createdAt": 1700000000000,
        "checkedAt": 1700000001000,
        "skillUrl": f"http://127.0.0.1:{PORT}/openclaw/skills/{skill['slug']}",
        "securityAuditUrl": f"http://127.0.0.1:{PORT}/openclaw/skills/{skill['slug']}/security-audit?version={skill['version']}",
    }
    if status == "clean":
        return {**base, "ok": True, "decision": "pass", "reasons": [], "security": {"status": "clean", "passed": True}}
    if status == "suspicious":
        return {**base, "ok": False, "decision": "fail", "reasons": ["security.status_not_clean"], "security": {"status": "suspicious", "passed": False}}
    return {**base, "ok": False, "decision": "fail", "reasons": ["moderation.malware_blocked"], "security": {"status": "malicious", "passed": False}}

def log(event, **data):
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": time.time(), "event": event, **data}, sort_keys=True) + "\n")

class Handler(BaseHTTPRequestHandler):
    server_version = "ClawHubProof/1.0"

    def _send_json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        log("GET", path=parsed.path, query=qs)
        if parsed.path == "/api/v1/search":
            query = " ".join(qs.get("q", [])).lower()
            tokens = [token for token in query.split() if token]
            results = []
            for skill in SKILLS.values():
                haystack = f"{skill['slug']} {skill['displayName']} {skill['summary']}".lower()
                if all(token in haystack for token in tokens):
                    results.append(skill_summary(skill))
            self._send_json({"results": results})
            return
        if parsed.path.startswith("/api/v1/skills/") and parsed.path.count("/") == 4:
            slug = parsed.path.rsplit("/", 1)[-1]
            skill = SKILLS.get(slug)
            if skill:
                self._send_json(skill_detail(skill))
                return
        if parsed.path.startswith("/api/v1/skills/") and parsed.path.endswith("/verify"):
            slug = parsed.path.split("/")[-2]
            skill = SKILLS.get(slug)
            if skill:
                self._send_json({
                    "schema": "clawhub.skill.verify.v1",
                    "ok": skill["safety"] != "malicious",
                    "decision": "pass" if skill["safety"] == "clean" else "fail",
                    "reasons": [] if skill["safety"] == "clean" else ["security.status_not_clean"],
                    "slug": skill["slug"],
                    "displayName": skill["displayName"],
                    "publisherHandle": skill["ownerHandle"],
                    "publisherDisplayName": "OpenClaw Proof",
                    "skill": {"slug": skill["slug"], "displayName": skill["displayName"]},
                    "publisher": {"handle": skill["ownerHandle"], "displayName": "OpenClaw Proof"},
                    "version": {"version": skill["version"]},
                    "card": {},
                    "artifact": {},
                    "provenance": {"sourceUrl": f"http://127.0.0.1:{PORT}/openclaw/skills/{skill['slug']}"},
                    "security": {"status": skill["safety"], "passed": skill["safety"] == "clean"},
                    "signature": {},
                })
                return
        if parsed.path == "/api/v1/download":
            slug = (qs.get("slug") or [""])[0]
            skill = SKILLS.get(slug)
            if skill and skill.get("zipPath"):
                with open(skill["zipPath"], "rb") as fh:
                    raw = fh.read()
                self.send_response(200)
                self.send_header("content-type", "application/zip")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            self._send_json({"error": "not_found", "slug": slug}, status=404)
            return
        self._send_json({"error": "not_found", "path": parsed.path}, status=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("content-length") or "0")
        body = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        log("POST", path=parsed.path, payload=payload)
        if parsed.path == "/api/v1/skills/-/security-verdicts":
            items = []
            for request_item in payload.get("items", []):
                skill = SKILLS.get(request_item.get("slug") or request_item.get("requestedSlug") or "")
                if skill is None:
                    skill = SKILLS["proof-blocked-skill"]
                items.append(verdict(skill, request_item))
            self._send_json({"schema": "clawhub.skill.security-verdicts.v1", "items": items})
            return
        self._send_json({"error": "not_found", "path": parsed.path}, status=404)

    def log_message(self, format, *args):
        log("access", message=format % args)

if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log("listening", port=PORT)
    server.serve_forever()
PY
  python3 proof-output/clawhub-fixture-server.py > proof-output/clawhub-mock.log 2>&1 &
  CLAW_HUB_PID="$!"
  for attempt in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${CLAW_HUB_PORT}/api/v1/search?q=proof&limit=3" > proof-output/clawhub-search-smoke.json; then
      return 0
    fi
    if ! kill -0 "${CLAW_HUB_PID}" >/dev/null 2>&1; then
      echo "ClawHub fixture exited before becoming healthy" >&2
      return 1
    fi
    sleep 1
  done
  echo "Timed out waiting for ClawHub fixture" >&2
  return 1
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

approve_pending_device_pairings() {
  local attempts="${1:-90}"
  local require_pending="${2:-false}"
  local approval_scope="${3:-admin}"
  local approved_count=0
  local raw_list="proof-output/device-pair-list.raw.json"
  local ids_file="proof-output/device-pair-pending-ids.txt"
  for attempt in $(seq 1 "${attempts}"); do
    write_device_pair_list_snapshot "${raw_list}"
    redact_json_file "${raw_list}" proof-output/device-pair-list.json
    select_android_pending_request_ids "${raw_list}" > "${ids_file}"
    if [ ! -s "${ids_file}" ]; then
      if [ "${approved_count}" -gt 0 ] || [ "${require_pending}" != "true" ]; then
        rm -f "${raw_list}"
        return 0
      fi
    else
      while IFS= read -r request_id; do
        [ -z "${request_id}" ] && continue
        local safe_id
        safe_id="$(printf '%s' "${request_id}" | tr -c 'A-Za-z0-9_.-' '_')"
        if [ "${approval_scope}" = "limited" ]; then
          echo "[proof] restrict pending Android pairing ${request_id} to non-admin operator scopes" | tee -a proof-output/capture.log
          restrict_pending_pairing_scopes "${request_id}"
        fi
        local approve_json="proof-output/device-pair-approve-${safe_id}.json"
        echo "[proof] approve pending Android pairing ${request_id}" | tee -a proof-output/capture.log
        approve_pairing_direct_from_state "${request_id}" "${approve_json}" 2> "proof-output/device-pair-approve-${safe_id}.err"
        approved_count=$((approved_count + 1))
      done < "${ids_file}"
      sleep 2
    fi
    sleep 1
  done
  rm -f "${raw_list}"
  if [ "${approved_count}" -gt 0 ]; then
    return 0
  fi
  echo "Timed out waiting for a pending Android device pairing request" >&2
  return 1
}

android_operator_admin_paired() {
  local input_path="$1"
  python3 - "$input_path" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
for device in data.get("paired", []) if isinstance(data, dict) else []:
    fields = " ".join(str(device.get(key) or "").lower() for key in ("platform", "deviceFamily", "clientId", "displayName"))
    scopes = {str(scope) for scope in device.get("scopes", [])}
    roles = {str(role) for role in device.get("roles", [])}
    if "android" in fields and "operator" in roles and "operator.admin" in scopes:
        raise SystemExit(0)
raise SystemExit(1)
PY
}

wait_for_android_operator_pairing() {
  local attempts="${1:-120}"
  local raw_list="proof-output/device-pair-list.raw.json"
  for _ in $(seq 1 "${attempts}"); do
    approve_pending_device_pairings 1 || true
    write_device_pair_list_snapshot "${raw_list}"
    redact_json_file "${raw_list}" proof-output/device-pair-list.json
    if android_operator_admin_paired "${raw_list}"; then
      rm -f "${raw_list}"
      return 0
    fi
    sleep 1
  done
  rm -f "${raw_list}"
  echo "Timed out waiting for Android operator.admin pairing" >&2
  return 1
}

wait_for_text_absent() {
  local needle="$1"
  local attempts="${2:-45}"
  local out="proof-output/openclaw-ui.xml"
  for _ in $(seq 1 "${attempts}"); do
    timeout 20 adb shell uiautomator dump /sdcard/openclaw-ui.xml >/dev/null 2>&1 || true
    timeout 20 adb pull /sdcard/openclaw-ui.xml "${out}" >/dev/null 2>&1 || true
    if [ -f "${out}" ] && ! grep -Fq "${needle}" "${out}"; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for UI text to disappear: ${needle}" >&2
  return 1
}

start_real_gateway() {
  write_gateway_config
  start_clawhub_fixture
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

  run_openclaw_gateway_call skills.search \
    --params '{"query":"proof","limit":10}' \
    --timeout 20000 \
    --json > proof-output/gateway-skills-search.json
  run_openclaw_gateway_call skills.detail \
    --params '{"slug":"proof-clean-skill"}' \
    --timeout 20000 \
    --json > proof-output/gateway-skills-clean-detail.json
  run_openclaw_gateway_call skills.securityVerdicts \
    --params '{"items":[{"slug":"proof-clean-skill","version":"1.2.3","ownerHandle":"openclaw"},{"slug":"proof-warning-skill","version":"2.0.0","ownerHandle":"openclaw"},{"slug":"proof-blocked-skill","version":"9.9.9","ownerHandle":"openclaw"}]}' \
    --timeout 20000 \
    --json > proof-output/gateway-skills-verdicts.json

  python3 - <<'PY'
from pathlib import Path
needles = ["Proof Clean Skill", "Proof Warning Skill", "Proof Blocked Skill", "proof-clean-skill", "clean", "suspicious", "malicious", "security-verdicts"]
combined = "\n".join(Path(p).read_text(encoding="utf-8", errors="ignore") for p in [
    "proof-output/gateway-skills-search.json",
    "proof-output/gateway-skills-clean-detail.json",
    "proof-output/gateway-skills-verdicts.json",
    "proof-output/clawhub-fixture.jsonl",
])
missing = [needle for needle in needles if needle not in combined]
if missing:
    raise SystemExit(f"Missing expected Gateway/ClawHub proof output: {missing}")
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
  local occurrence="${2:-0}"
  copy_ui_xml proof-output/openclaw-ui.xml >/dev/null 2>&1 || true
  python3 - "$needle" "$occurrence" proof-output/openclaw-ui.xml <<'PY'
import html
import re
import sys
from pathlib import Path
needle = sys.argv[1]
occurrence = sys.argv[2]
xml = Path(sys.argv[3]).read_text(encoding='utf-8', errors='ignore')
matches = []
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
    if right <= left or bottom <= top:
        continue
    matches.append(((left + right) // 2, (top + bottom) // 2, text, desc))
if not matches:
    sys.exit(1)
index = -1 if occurrence == 'last' else int(occurrence)
x, y, _, _ = matches[index]
print(x, y)
PY
}

tap_text() {
  local needle="$1"
  local fallback_coords="${2:-}"
  local occurrence="${3:-0}"
  local coords=""
  if coords="$(text_center "$needle" "$occurrence" 2>/dev/null)" && [ -n "$coords" ]; then
    echo "[proof] tap '${needle}' at ${coords}" | tee -a proof-output/capture.log
    adb shell input tap $coords
    sleep 1
    return 0
  fi
  if [ -n "$fallback_coords" ]; then
    echo "[proof] tap fallback '${needle}' at ${fallback_coords}" | tee -a proof-output/capture.log
    adb shell input tap $fallback_coords
    sleep 1
    return 0
  fi
  echo "Could not find tappable UI text: ${needle}" >&2
  return 1
}

tap_switch_on_row() {
  local row_label="$1"
  local fallback_y="${2:-620}"
  local coords=""
  local y="${fallback_y}"
  if coords="$(text_center "${row_label}" 0 2>/dev/null)" && [ -n "${coords}" ]; then
    y="$(printf '%s' "${coords}" | awk '{print $2}')"
  fi
  echo "[proof] tap switch for '${row_label}' at 945 ${y}" | tee -a proof-output/capture.log
  adb shell input tap 945 "${y}"
  sleep 1
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

seed_manual_gateway_prefs() {
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

launch_app() {
  local log_name="${1:-monkey-launch.log}"
  adb shell am force-stop "$APP_ID" || true
  timeout 30 adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 > "proof-output/${log_name}" || true
  wait_for_text "$SETTINGS_TEXT" 90
}

pair_current_app_session() {
  local approval_scope="${1:-admin}"
  if wait_for_text "Reconnect" 8; then
    tap_text "Reconnect" "570 1070" || true
    sleep 4
  fi
  if wait_for_text "Pairing needed" 15 || wait_for_text "Waiting for pairing" 5; then
    approve_pending_device_pairings 90 true "${approval_scope}"
    tap_text "Reconnect" "570 1070" || tap_text "Reconnect gateway" "570 1070" || true
    sleep 8
  fi
}

open_skills_screen() {
  tap_text "$SETTINGS_TEXT" "945 2290" "last"
  wait_for_text "$SKILLS_TEXT" 60
  tap_text "$SKILLS_TEXT" "230 1560"
  wait_for_text "Search installed skills" 90
  wait_for_text_absent "Connect the gateway to load and manage skills." 90
}

collapse_installed_skills_for_clawhub() {
  # The proof checkout can include dozens of bundled skills. Filter the installed
  # list to a deterministic no-match query so the ClawHub panel is reachable
  # without depending on long-list scroll physics in the emulator.
  if wait_for_text "Search ClawHub skills" 3; then
    return 0
  fi
  wait_for_text "Search installed skills" 45
  tap_text "Search installed skills" "420 1110"
  adb shell input text 'zzzzzzzz'
  adb shell input keyevent 4 || true
  wait_for_text "No installed skills match this search." 30
  for _ in $(seq 1 10); do
    if wait_for_text "Search ClawHub skills" 2; then
      return 0
    fi
    adb shell input swipe 540 2150 540 900 500 || true
    sleep 1
  done
  wait_for_text "Search ClawHub skills" 30
}

reset_android_app_and_pairing() {
  run_openclaw devices clear --pending --yes --json > proof-output/device-clear-before-admin.json 2> proof-output/device-clear-before-admin.err || true
  adb shell pm clear "$APP_ID" > proof-output/adb-pm-clear-before-admin.log || true
  seed_manual_gateway_prefs
}

search_clawhub_query() {
  local query_text="$1"
  local expected_title="$2"
  local prefix="$3"
  for _ in $(seq 1 8); do
    if wait_for_text "Search ClawHub skills" 2; then
      break
    fi
    adb shell input swipe 540 2200 540 600 800 || true
    sleep 1
  done
  wait_for_text "Search ClawHub skills" 45
  tap_text "Search ClawHub skills" "420 1580"
  adb shell input text "${query_text}"
  adb shell input keyevent 4 || true
  for _ in $(seq 1 4); do
    if wait_for_text "Search ClawHub" 2; then
      break
    fi
    adb shell input swipe 540 2150 540 1720 350 || true
    sleep 1
  done
  wait_for_text "Search ClawHub" 30
  capture_png "/sdcard/openclaw-${prefix}-query.png" "proof-output/${prefix}-query-before-search.png"
  copy_ui_xml "proof-output/${prefix}-query-ui.xml"
  tap_text "Search ClawHub" "300 1720"
  for _ in $(seq 1 10); do
    if wait_for_text "${expected_title}" 3; then
      break
    fi
    adb shell input swipe 540 2100 540 1250 500 || true
    sleep 1
  done
  wait_for_text "${expected_title}" 90
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

# Install the actual Play debug APK produced from this repository head.
timeout 120 adb install -r "$APK" > proof-output/adb-install.log

# Seed completed onboarding plus a manual loopback Gateway endpoint. ClawHub result data is
# still retrieved from the live proof Gateway through WebSocket RPC and Gateway HTTP fetches.
seed_manual_gateway_prefs

# Phase 1: approve the Android pairing with non-admin operator scopes and capture the admin gate.
launch_app monkey-launch-limited.log
pair_current_app_session limited
capture_png /sdcard/openclaw-01-limited-launch.png proof-output/01-limited-launch-connected-gateway.png
copy_ui_xml proof-output/01-limited-launch-ui.xml
open_skills_screen
wait_for_text "Skill toggles and ClawHub installs require operator.admin" 90
capture_png /sdcard/openclaw-02-limited-admin-gate.png proof-output/02-limited-admin-gate.png
copy_ui_xml proof-output/02-limited-admin-gate-ui.xml
record_screen /sdcard/openclaw-limited-admin-gate.mp4 proof-output/limited-admin-gate.mp4 5
collapse_installed_skills_for_clawhub
search_clawhub_query 'proof%sclean' "$PROOF_SKILL_TITLE" "03-limited-clawhub"
capture_png /sdcard/openclaw-03-limited-clawhub-results.png proof-output/03-limited-clawhub-results-install-disabled.png
copy_ui_xml proof-output/03-limited-clawhub-results-ui.xml
record_screen /sdcard/openclaw-limited-install-disabled.mp4 proof-output/limited-install-disabled.mp4 5

# Phase 2: reset the proof-only app/pairing state and approve the same Android build with admin.
reset_android_app_and_pairing
launch_app monkey-launch-admin.log
pair_current_app_session admin
wait_for_android_operator_pairing 120
if wait_for_text "Reconnect" 3 || wait_for_text "Reconnect gateway" 3; then
  tap_text "Reconnect" "570 1070" || tap_text "Reconnect gateway" "570 1070" || true
  sleep 8
fi
capture_png /sdcard/openclaw-04-admin-launch.png proof-output/04-admin-launch-connected-gateway.png
copy_ui_xml proof-output/04-admin-launch-ui.xml

# Navigate through the production bottom navigation to Settings, then into Skills.
tap_text "$SETTINGS_TEXT" "945 2290" "last"
wait_for_text "$SKILLS_TEXT" 60
capture_png /sdcard/openclaw-05-settings-list.png proof-output/05-settings-list.png
copy_ui_xml proof-output/05-settings-list-ui.xml
record_screen /sdcard/openclaw-settings-list.mp4 proof-output/settings-list.mp4 4

tap_text "$SKILLS_TEXT" "230 1560"
wait_for_text "Search installed skills" 90
wait_for_text_absent "Connect the gateway to load and manage skills." 90
capture_png /sdcard/openclaw-06-skills-entry.png proof-output/06-real-skills-entry.png
copy_ui_xml proof-output/06-skills-entry-ui.xml

# Prove installed-skill enable/disable behavior through the real detail switch.
tap_text "acp-router" "250 1945"
wait_for_text "Gateway switch" 60
capture_png /sdcard/openclaw-07-switch-on.png proof-output/07-admin-skill-detail-switch-on.png
copy_ui_xml proof-output/07-admin-skill-detail-switch-on-ui.xml
record_screen /sdcard/openclaw-admin-toggle-disable.mp4 proof-output/admin-toggle-disable.mp4 4 &
TOGGLE_REC_PID="$!"
tap_switch_on_row "Gateway switch" 620
sleep 5
wait "$TOGGLE_REC_PID" || true
capture_png /sdcard/openclaw-08-switch-off.png proof-output/08-admin-skill-detail-switch-off.png
copy_ui_xml proof-output/08-admin-skill-detail-switch-off-ui.xml
gateway_call_capture skills.status '{}' gateway-skills-status-after-disable
record_screen /sdcard/openclaw-admin-toggle-enable.mp4 proof-output/admin-toggle-enable.mp4 4 &
TOGGLE_REC_PID="$!"
tap_switch_on_row "Gateway switch" 620
sleep 5
wait "$TOGGLE_REC_PID" || true
capture_png /sdcard/openclaw-09-switch-on-again.png proof-output/09-admin-skill-detail-switch-on-again.png
copy_ui_xml proof-output/09-admin-skill-detail-switch-on-again-ui.xml
gateway_call_capture skills.status '{}' gateway-skills-status-after-enable
adb shell input keyevent 4 || true
wait_for_text "Search installed skills" 30

# Collapse the long installed-skills list first, then bring the ClawHub panel into view.
collapse_installed_skills_for_clawhub
sleep 1
capture_png /sdcard/openclaw-10-installed-filter.png proof-output/10-installed-filter-no-matches.png
copy_ui_xml proof-output/10-installed-filter-ui.xml

# Clean install: search, review, and complete the real install.
search_clawhub_query 'proof%sclean' "$PROOF_SKILL_TITLE" "11-clean-clawhub"
capture_png /sdcard/openclaw-11-clean-results.png proof-output/11-clean-clawhub-search-results.png
copy_ui_xml proof-output/11-clean-clawhub-results-ui.xml
record_screen /sdcard/openclaw-clean-results.mp4 proof-output/clean-results.mp4 5
tap_text "Install" "905 1930" "last"
wait_for_text "$REVIEW_TITLE" 120
capture_png /sdcard/openclaw-12-clean-review.png proof-output/12-clean-review-dialog.png
copy_ui_xml proof-output/12-clean-review-dialog-ui.xml
record_screen /sdcard/openclaw-clean-install-complete.mp4 proof-output/clean-install-complete.mp4 10 &
INSTALL_REC_PID="$!"
tap_text "Install" "820 1740" "last"
wait_for_text "Installed proof-clean-skill@1.2.3" 120
wait "$INSTALL_REC_PID" || true
capture_png /sdcard/openclaw-13-clean-installed.png proof-output/13-clean-install-complete.png
copy_ui_xml proof-output/13-clean-install-complete-ui.xml
gateway_call_capture skills.status '{}' gateway-skills-status-after-clean-install

# Review-required install: refresh the app UI state, search warning, acknowledge, and complete install.
launch_app monkey-launch-warning.log
open_skills_screen
collapse_installed_skills_for_clawhub
search_clawhub_query 'proof%swarning' "$WARNING_SKILL_TITLE" "14-warning-clawhub"
tap_text "Install" "905 1930" "last"
wait_for_text "$REVIEW_TITLE" 120
wait_for_text "Review required" 30
capture_png /sdcard/openclaw-15-warning-review.png proof-output/15-warning-review-dialog.png
copy_ui_xml proof-output/15-warning-review-dialog-ui.xml
gateway_call_capture skills.securityVerdicts '{"items":[{"slug":"proof-warning-skill","version":"2.0.0","ownerHandle":"openclaw"}]}' gateway-skills-warning-verdict
record_screen /sdcard/openclaw-warning-install-complete.mp4 proof-output/warning-install-complete.mp4 10 &
WARNING_REC_PID="$!"
tap_text "Acknowledge and install" "760 1740" "last"
wait_for_text "Installed proof-warning-skill@2.0.0" 120
wait "$WARNING_REC_PID" || true
capture_png /sdcard/openclaw-16-warning-installed.png proof-output/16-warning-install-complete.png
copy_ui_xml proof-output/16-warning-install-complete-ui.xml
gateway_call_capture skills.status '{}' gateway-skills-status-after-warning-install

# Blocked install: refresh, search blocked, capture blocked dialog, and prove Gateway rejects install.
launch_app monkey-launch-blocked.log
open_skills_screen
collapse_installed_skills_for_clawhub
search_clawhub_query 'proof%sblocked' "$BLOCKED_SKILL_TITLE" "17-blocked-clawhub"
tap_text "Install" "905 1930" "last"
wait_for_text "$REVIEW_TITLE" 120
wait_for_text "Blocked" 30
capture_png /sdcard/openclaw-18-blocked-review.png proof-output/18-blocked-review-dialog.png
copy_ui_xml proof-output/18-blocked-review-dialog-ui.xml
record_screen /sdcard/openclaw-blocked-review-dialog.mp4 proof-output/blocked-review-dialog.mp4 6
gateway_call_capture skills.securityVerdicts '{"items":[{"slug":"proof-blocked-skill","version":"9.9.9","ownerHandle":"openclaw"}]}' gateway-skills-blocked-verdict
gateway_call_capture skills.install '{"source":"clawhub","slug":"proof-blocked-skill","version":"9.9.9","acknowledgeClawHubRisk":true,"timeoutMs":120000}' gateway-skills-blocked-install-rejected

python3 - <<'PY'
from pathlib import Path
import html
import json
import re

checks = {
    '02-limited-admin-gate-ui.xml': ['Skill toggles and ClawHub installs require operator.admin'],
    '03-limited-clawhub-results-ui.xml': ['Proof Clean Skill', 'Install'],
    '07-admin-skill-detail-switch-on-ui.xml': ['Gateway switch'],
    '08-admin-skill-detail-switch-off-ui.xml': ['Gateway switch'],
    '09-admin-skill-detail-switch-on-again-ui.xml': ['Gateway switch'],
    '11-clean-clawhub-results-ui.xml': ['Proof Clean Skill', 'Install'],
    '12-clean-review-dialog-ui.xml': ['Review ClawHub audit', 'Proof Clean Skill', 'Safety', 'Clean', 'Install'],
    '13-clean-install-complete-ui.xml': ['Installed proof-clean-skill@1.2.3'],
    '15-warning-review-dialog-ui.xml': ['Review ClawHub audit', 'Proof Warning Skill', 'Review required', 'Acknowledge and install'],
    '16-warning-install-complete-ui.xml': ['Installed proof-warning-skill@2.0.0'],
    '18-blocked-review-dialog-ui.xml': ['Review ClawHub audit', 'Proof Blocked Skill', 'Blocked'],
    'gateway-skills-search.json': ['Proof Clean Skill', 'proof-clean-skill', 'Proof Warning Skill', 'Proof Blocked Skill'],
    'gateway-skills-verdicts.json': ['clean', 'suspicious', 'malicious', 'securityAuditUrl'],
    'gateway-skills-status-after-disable.json': ['acp-router'],
    'gateway-skills-status-after-enable.json': ['acp-router'],
    'gateway-skills-status-after-clean-install.json': ['proof-clean-skill'],
    'gateway-skills-status-after-warning-install.json': ['proof-warning-skill'],
    'gateway-skills-blocked-install-rejected.json': ['blocked'],
    'clawhub-fixture.jsonl': ['/api/v1/search', '/api/v1/skills/-/security-verdicts', '/api/v1/download'],
}
missing = []
for rel, needles in checks.items():
    text = Path('proof-output', rel).read_text(encoding='utf-8', errors='ignore')
    for needle in needles:
        if needle not in text:
            missing.append(f'{rel}: {needle}')

limited_results = Path('proof-output/03-limited-clawhub-results-ui.xml').read_text(encoding='utf-8', errors='ignore')
install_disabled = False
for node in re.findall(r'<node\b[^>]*/?>', limited_results):
    text = html.unescape((re.search(r'text="([^"]*)"', node) or [None, ''])[1])
    desc = html.unescape((re.search(r'content-desc="([^"]*)"', node) or [None, ''])[1])
    enabled = (re.search(r'enabled="([^"]*)"', node) or [None, ''])[1]
    if 'Install' in text or 'Install' in desc:
        install_disabled = enabled == 'false'
        if install_disabled:
            break
if not install_disabled:
    missing.append('03-limited-clawhub-results-ui.xml: disabled Install control')

def load_json(rel):
    return json.loads(Path('proof-output', rel).read_text(encoding='utf-8'))

def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)

def skill_disabled(rel, key):
    for obj in walk(load_json(rel)):
        names = {str(obj.get('skillKey', '')), str(obj.get('name', '')), str(obj.get('id', ''))}
        if key in names and isinstance(obj.get('disabled'), bool):
            return obj['disabled']
    return None

if skill_disabled('gateway-skills-status-after-disable.json', 'acp-router') is not True:
    missing.append('gateway-skills-status-after-disable.json: acp-router disabled=true')
if skill_disabled('gateway-skills-status-after-enable.json', 'acp-router') is not False:
    missing.append('gateway-skills-status-after-enable.json: acp-router disabled=false')

blocked_text = ''.join(
    Path('proof-output', rel).read_text(encoding='utf-8', errors='ignore')
    for rel in ['gateway-skills-blocked-install-rejected.json', 'gateway-skills-blocked-install-rejected.err']
    if Path('proof-output', rel).exists()
)
if 'clawhub_download_blocked' not in blocked_text:
    missing.append('gateway-skills-blocked-install-rejected: clawhub_download_blocked')

if missing:
    raise SystemExit('Missing expected proof evidence: ' + ', '.join(missing))
PY

cat > proof-output/README.md <<EOF
# Android ClawHub Skills real media proof v2

- Repository head: $(git rev-parse HEAD)
- PR head expectation: $(tr -d '[:space:]' < scripts/proof/pr101864-expected-head.txt 2>/dev/null || true)
- Runner: GitHub-hosted ubuntu-24.04 + Android emulator API 35
- App launch mode: normal Android launcher; screenshot mode disabled
- Gateway paths: Android Settings → Skills admin gate, installed-skill switch, ClawHub clean install, ClawHub warning acknowledgement, ClawHub blocked review
- RPC evidence: skills.search, skills.detail, skills.securityVerdicts, skills.status, and skills.install via a temporary OpenClaw Gateway started from this checkout
- ClawHub fixture: local ClawHub-compatible HTTP service inside this Actions run, logged in clawhub-fixture.jsonl

Key media:
- 02-limited-admin-gate.png
- 03-limited-clawhub-results-install-disabled.png
- 07-admin-skill-detail-switch-on.png
- 08-admin-skill-detail-switch-off.png
- 09-admin-skill-detail-switch-on-again.png
- 12-clean-review-dialog.png
- 13-clean-install-complete.png
- 15-warning-review-dialog.png
- 16-warning-install-complete.png
- 18-blocked-review-dialog.png
- limited-admin-gate.mp4
- limited-install-disabled.mp4
- admin-toggle-disable.mp4
- admin-toggle-enable.mp4
- clean-install-complete.mp4
- warning-install-complete.mp4
- blocked-review-dialog.mp4
EOF

find proof-output -maxdepth 1 -type f -printf '%f\n' | sort > proof-output/artifact-manifest.txt
