"""Validate or run the kept Open-Inspect session environment on a Revyl macOS computer."""

from __future__ import annotations

import argparse
import json
import os
import pwd
import sys
from pathlib import Path

WORKSPACE = Path("/workspace")
FALLBACK_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"


def load_environment(path: Path) -> dict[str, str]:
    session = json.loads(path.read_text())
    environment = session.get("env") if isinstance(session, dict) else None
    if (
        not isinstance(session.get("sandboxId"), str)
        or not isinstance(environment, dict)
        or not all(
            isinstance(key, str) and isinstance(value, str) for key, value in environment.items()
        )
        or int(environment.get("SANDBOX_TIMEOUT_SECONDS", "0")) <= 0
    ):
        # Field-free message: the values are secrets.
        raise ValueError("not a session environment")
    return environment


def run(path: Path) -> None:
    environment = load_environment(path)
    account = pwd.getpwuid(os.getuid())
    home = Path(account.pw_dir)
    state = home / ".openinspect"
    for directory in (state / "state", Path("/tmp/opencode"), home / ".cache/openinspect/scm"):
        directory.mkdir(parents=True, exist_ok=True)
    marker = state / "boot-complete"
    environment.update(
        {
            "OPENINSPECT_STATE_DIR": str(state / "state"),
            "OI_BOOT_COMPLETE_MARKER": str(marker),
            "RESTORED_FROM_SNAPSHOT": "true" if marker.exists() else "false",
            "HOME": str(home),
            "USER": account.pw_name,
            "LOGNAME": account.pw_name,
            "OPENINSPECT_REAL_GH": "/opt/homebrew/bin/gh",
            "PATH": environment.get("PATH") or FALLBACK_PATH,
        }
    )
    os.chdir(WORKSPACE)
    os.execve(
        sys.executable,
        [sys.executable, "-B", "-m", "sandbox_runtime.entrypoint"],
        environment,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", type=Path)
    mode.add_argument("--run", type=Path)
    arguments = parser.parse_args()
    try:
        if arguments.check:
            load_environment(arguments.check)
        else:
            run(arguments.run)
    except (OSError, ValueError) as error:
        print(f"run-runtime: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
