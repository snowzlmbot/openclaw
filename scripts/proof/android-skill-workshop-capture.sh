#!/usr/bin/env bash
set -euo pipefail
mkdir -p proof-output
APK="apps/android/app/build/outputs/apk/play/debug/app-play-debug.apk"
: "${AVD_NAME:=OpenClaw_Skill_Workshop_API35}"

emulator -avd "$AVD_NAME" -no-window -no-snapshot -no-snapshot-save -gpu swiftshader_indirect -memory 2048 -cores 2 > proof-output/emulator.log 2>&1 &
EMU_PID=$!
cleanup() {
  timeout 5 adb emu kill >/dev/null 2>&1 || true
  wait "$EMU_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

timeout 240 adb wait-for-device
for i in $(seq 1 180); do
  boot_completed="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  [ "$boot_completed" = "1" ] && break
  sleep 1
done
adb shell wm size 1080x2400 || true
adb shell wm density 420 || true

timeout 120 adb install -r "$APK" > proof-output/adb-install.log
# Launch the real installed APK on the emulator. No screenshot mode is used here.
timeout 30 adb shell monkey -p ai.openclaw.app -c android.intent.category.LAUNCHER 1 > proof-output/monkey-launch.log || true
sleep 10
adb shell screencap -p /sdcard/openclaw-real-launch.png
timeout 20 adb pull /sdcard/openclaw-real-launch.png proof-output/01-real-openclaw-launch.png

# Record a short video of the actual emulator state after launch.
timeout 12 adb shell screenrecord --time-limit 5 /sdcard/openclaw-real-proof.mp4 >/dev/null 2>&1 || true
timeout 20 adb pull /sdcard/openclaw-real-proof.mp4 proof-output/openclaw-real-proof.mp4 || true

timeout 20 adb shell uiautomator dump /sdcard/openclaw-ui.xml >/dev/null 2>&1 || true
timeout 20 adb pull /sdcard/openclaw-ui.xml proof-output/openclaw-ui.xml || true

{
  echo "target_commit=$(git rev-parse HEAD)"
  echo "apk=$APK"
  echo "runner=$(uname -a)"
  echo "proof_type=real GitHub Actions emulator launch capture"
  echo "note=no screenshot mode; installed app launched via monkey"
  echo "adb_devices:"; adb devices
  echo "captures:"; find proof-output -maxdepth 1 -type f -printf '%f\n' | sort
} > proof-output/proof-manifest.txt
