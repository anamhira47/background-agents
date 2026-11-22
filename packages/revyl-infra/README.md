# revyl-infra

Guest files and the base-snapshot build for the Revyl sandbox provider (`SANDBOX_PROVIDER=revyl`);
see [docs/REVYL_SANDBOX_PROVIDER.md](../../docs/REVYL_SANDBOX_PROVIDER.md).

- `build-base-snapshot.sh` creates a persistent macOS computer, installs the runtime with
  `guest/install.sh`, stops it and saves its disk as a named snapshot. Run it again after
  `packages/sandbox-runtime` or this package change.
- `guest/ai.openinspect.sandbox.plist` is a LaunchDaemon that runs `guest/launcher.sh` as the
  `computer` account at every boot.
- `guest/start-session.sh` (installed as `/opt/openinspect/revyl/start-session`) is the one command
  the control plane runs per session, with the bootstrap URL and single-use token on stdin.
- `guest/run-runtime.py` validates the redeemed session environment and execs the runtime with its
  state under `~/.openinspect`, which survives stop and start.
