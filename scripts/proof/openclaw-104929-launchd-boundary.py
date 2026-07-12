#!/usr/bin/env python3
"""Public evidence probe for launchd descendant containment boundaries."""

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


def wait_for(path: Path, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists() and path.stat().st_size:
            return
        time.sleep(0.1)
    raise TimeoutError(f"timed out waiting for {path}")


def write_worker(path: Path) -> None:
    path.write_text(
        """
import json
import os
import subprocess
import sys
import time

pid_file = sys.argv[1]
plain = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
setsid = subprocess.Popen(
    [sys.executable, "-c", "import time; time.sleep(300)"],
    start_new_session=True,
)
daemon_file = pid_file + ".daemon"
daemon_code = r'''\
import os
import sys
import time
pid_file = sys.argv[1]
if os.fork() > 0:
    os._exit(0)
os.setsid()
if os.fork() > 0:
    os._exit(0)
with open(pid_file, "w", encoding="utf-8") as handle:
    handle.write(str(os.getpid()))
    handle.flush()
time.sleep(300)
'''
subprocess.run([sys.executable, "-c", daemon_code, daemon_file], check=True)
deadline = time.monotonic() + 10
while time.monotonic() < deadline and not os.path.exists(daemon_file):
    time.sleep(0.05)
with open(daemon_file, encoding="utf-8") as handle:
    daemon_pid = int(handle.read().strip())
with open(pid_file, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "leader": os.getpid(),
            "plain": plain.pid,
            "setsid": setsid.pid,
            "daemon": daemon_pid,
        },
        handle,
        sort_keys=True,
    )
    handle.flush()
time.sleep(300)
""".lstrip(),
        encoding="utf-8",
    )


def main() -> int:
    label = f"ai.openclaw.evidence.104929.{os.getpid()}"
    target = f"gui/{os.getuid()}"
    service = f"{target}/{label}"
    pids: dict[str, int] = {}
    bootstrapped = False

    with tempfile.TemporaryDirectory(prefix="openclaw-104929-launchd-") as temp:
        root = Path(temp)
        worker = root / "worker.py"
        pid_file = root / "pids.json"
        stdout_file = root / "stdout.log"
        stderr_file = root / "stderr.log"
        plist_file = root / f"{label}.plist"
        write_worker(worker)
        with plist_file.open("wb") as handle:
            plistlib.dump(
                {
                    "Label": label,
                    "ProgramArguments": [sys.executable, str(worker), str(pid_file)],
                    "RunAtLoad": True,
                    "ProcessType": "Interactive",
                    "AbandonProcessGroup": False,
                    "ExitTimeOut": 3,
                    "StandardOutPath": str(stdout_file),
                    "StandardErrorPath": str(stderr_file),
                },
                handle,
                sort_keys=True,
            )

        try:
            subprocess.run(["launchctl", "bootstrap", target, str(plist_file)], check=True)
            bootstrapped = True
            wait_for(pid_file)
            pids = json.loads(pid_file.read_text(encoding="utf-8"))
            before = {name: alive(pid) for name, pid in pids.items()}
            subprocess.run(["launchctl", "bootout", service], check=True)
            bootstrapped = False
            time.sleep(2)
            after = {name: alive(pid) for name, pid in pids.items()}
            evidence = {
                "service": service,
                "pids": pids,
                "alive_before_bootout": before,
                "alive_after_bootout": after,
                "expected_boundary": {
                    "leader_reaped": not after["leader"],
                    "plain_reaped": not after["plain"],
                    "setsid_survived": after["setsid"],
                    "double_fork_survived": after["daemon"],
                },
            }
            print(json.dumps(evidence, indent=2, sort_keys=True), flush=True)
            return 0 if all(evidence["expected_boundary"].values()) else 1
        finally:
            if bootstrapped:
                subprocess.run(["launchctl", "bootout", service], check=False)
            for pid in pids.values():
                if alive(pid):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == "__main__":
    raise SystemExit(main())

