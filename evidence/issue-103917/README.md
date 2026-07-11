# Issue 103917 current-head proof

This downstream-only evidence harness compares the affected `v2026.6.11` release with an exact
`openclaw/openclaw` `main` SHA. It does not modify OpenClaw product code.

The workflow:

1. verifies the proof branch differs from the requested upstream SHA only in proof files;
2. runs the merged lazy-root regression against the affected release and requires it to fail;
3. runs the same regression plus adjacent workspace and subagent suites against current main;
4. starts a real foreground Gateway and deterministic loopback model provider on Linux and macOS;
5. warms and deletes the `coder` workspace, invokes `sessions_spawn`, repeats deletion races, and
   verifies the same PID, HTTP health, authenticated RPC, and absence of unhandled rejection;
6. captures exact source/commit provenance;
7. renders four browser screenshots from the real test outputs;
8. uploads the complete artifact and publishes successful media under `runs/<run-id>/`.

Owner fix: [openclaw/openclaw#89226](https://github.com/openclaw/openclaw/pull/89226), merged as
`201686d9e30dbc85790f3e5c851a57e4d96d233e`.
