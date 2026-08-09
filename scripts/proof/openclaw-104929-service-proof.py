#!/usr/bin/env python3
"""Run exact candidate lease cleanup inside a real launchd service."""

from __future__ import annotations

import json
import os
import plistlib
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def wait_for(path: Path, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists() and path.stat().st_size:
            return
        time.sleep(0.1)
    raise TimeoutError(f"timed out waiting for {path}")


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("usage: service-proof.py <candidate-root> <artifact-dir> <node-path>")
    candidate = Path(sys.argv[1]).resolve()
    artifacts = Path(sys.argv[2]).resolve()
    node_path = Path(sys.argv[3]).resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    worker = candidate / "scripts/proof/openclaw-104929-service-worker.mts"
    tsx = candidate / "node_modules/tsx/dist/cli.mjs"
    label = f"ai.openclaw.evidence.104929.service.{os.getpid()}"
    target = f"gui/{os.getuid()}"
    service = f"{target}/{label}"
    pids: dict[str, int] = {}
    bootstrapped = False

    with tempfile.TemporaryDirectory(prefix="openclaw-104929-service-") as temp:
        control = Path(temp)
        ready = control / "ready.json"
        result = control / "result.json"
        plist_file = control / f"{label}.plist"
        with plist_file.open("wb") as handle:
            plistlib.dump(
                {
                    "Label": label,
                    "ProgramArguments": [str(node_path), str(tsx), str(worker), str(control)],
                    "WorkingDirectory": str(candidate),
                    "RunAtLoad": True,
                    "ProcessType": "Interactive",
                    "AbandonProcessGroup": False,
                    "ExitTimeOut": 3,
                    "StandardOutPath": str(artifacts / "service.stdout.log"),
                    "StandardErrorPath": str(artifacts / "service.stderr.log"),
                },
                handle,
                sort_keys=True,
            )
        try:
            subprocess.run(["launchctl", "bootstrap", target, str(plist_file)], check=True)
            bootstrapped = True
            wait_for(ready)
            pids = json.loads(ready.read_text(encoding="utf-8"))
            before = {
                "service": alive(pids["servicePid"]),
                "leased": alive(pids["leasedPid"]),
                "persistent": alive(pids["persistentPid"]),
            }
            (control / "abort").touch()
            wait_for(result)
            cleanup = json.loads(result.read_text(encoding="utf-8"))
            time.sleep(0.5)
            after = {
                "service": alive(pids["servicePid"]),
                "leased": alive(pids["leasedPid"]),
                "persistent": alive(pids["persistentPid"]),
            }
            evidence = {
                "candidate": subprocess.check_output(
                    ["git", "-C", str(candidate), "rev-parse", "HEAD"], text=True
                ).strip(),
                "service": service,
                "pids": pids,
                "alive_before_abort": before,
                "alive_after_abort": after,
                "cleanup": cleanup,
                "assertions": {
                    "service_alive": after["service"],
                    "leased_descendant_gone": not after["leased"],
                    "persistent_background_alive": after["persistent"],
                    "no_cleanup_survivors": not cleanup.get("survivingPids"),
                },
            }
            (artifacts / "service-proof.json").write_text(
                json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            print(json.dumps(evidence, indent=2, sort_keys=True))
            return 0 if all(evidence["assertions"].values()) else 1
        finally:
            if bootstrapped:
                subprocess.run(["launchctl", "bootout", service], check=False)
            for key in ("leasedPid", "persistentPid"):
                pid = pids.get(key)
                if pid and alive(pid):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == "__main__":
    raise SystemExit(main())
