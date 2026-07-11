## Current-main verification update

I reran this after the latest reporter updates clarified that the second and third occurrences did **not** require workspace deletion and could happen on the first or a repeated `coder` spawn.

### Exact scope

- Affected release: `v2026.6.11` at `e085fa1a3ffd32d0ea6917e1e6fb4ecbffbb77d2`
- Current `main`: `453c049ac89d8512688b300faa0f8da4b3d57935`
- Matching environment: `macos-14`, Node `26.4.0`
- Control environment: `ubuntu-24.04`, Node `24.18.0`
- Full run: https://github.com/snowzlmbot/openclaw/actions/runs/29171914343
- Permanent evidence commit: https://github.com/snowzlmbot/openclaw/commit/1833b6998280b5ac6e27f1da42d213cb963b8943

The proof branch is based on the exact upstream SHA and changes only the downstream proof workflow, test harness, and published evidence files.

### Results

1. The affected release still starts workspace-scoped `fsRoot(root)` eagerly in host write/edit tool construction. Running the current lazy-root regression against that release fails as expected.
2. Current `main` contains the lazy, memoized root acquisition from #89226 / `201686d9e30dbc85790f3e5c851a57e4d96d233e`. Its focused regression passes `2/2`; adjacent workspace/tool/subagent suites pass `99/99`.
3. A real foreground Gateway, authenticated RPC, real `sessions_spawn`, and deterministic loopback model provider were exercised on both platforms.
4. The matrix now includes the reporter's clarified no-deletion cases plus deletion controls:

| Scenario | Linux | macOS 14 / Node 26.4.0 |
| --- | --- | --- |
| First `coder` spawn, no deletion | completed | completed |
| Repeated `coder` spawn, no deletion | completed | completed |
| Recently attested role workspace removed | scoped `WorkspaceVanishedError` | scoped `WorkspaceVanishedError` |
| Five repeated deletion-race attempts | 5 scoped errors | 5 scoped errors |
| Gateway PID stable after all attempts | yes | yes |
| HTTP health + authenticated RPC after all attempts | pass | pass |
| `Unhandled promise rejection` signature | absent | absent |

Machine-readable outcomes:

- Linux: https://github.com/snowzlmbot/openclaw/blob/1833b6998280b5ac6e27f1da42d213cb963b8943/evidence/issue-103917/runs/29171914343/linux/full-gateway.json
- macOS: https://github.com/snowzlmbot/openclaw/blob/1833b6998280b5ac6e27f1da42d213cb963b8943/evidence/issue-103917/runs/29171914343/macos/full-gateway.json
- Source/run summary: https://github.com/snowzlmbot/openclaw/blob/1833b6998280b5ac6e27f1da42d213cb963b8943/evidence/issue-103917/runs/29171914343/linux/summary.json

### Media evidence

![Affected release versus current head](https://raw.githubusercontent.com/snowzlmbot/openclaw/1833b6998280b5ac6e27f1da42d213cb963b8943/evidence/issue-103917/runs/29171914343/linux/01-before-after.png)

![Root-cause provenance](https://raw.githubusercontent.com/snowzlmbot/openclaw/1833b6998280b5ac6e27f1da42d213cb963b8943/evidence/issue-103917/runs/29171914343/linux/02-root-cause.png)

![Current-head regression and adjacent suites](https://raw.githubusercontent.com/snowzlmbot/openclaw/1833b6998280b5ac6e27f1da42d213cb963b8943/evidence/issue-103917/runs/29171914343/linux/03-verification.png)

![Real Gateway containment](https://raw.githubusercontent.com/snowzlmbot/openclaw/1833b6998280b5ac6e27f1da42d213cb963b8943/evidence/issue-103917/runs/29171914343/linux/04-gateway-containment.png)

### Interpretation

This strongly supports the reported release behavior being covered by the already-merged lazy-root fix in #89226. On current `main`, first/repeated no-deletion spawns complete, while removed-workspace cases are returned as scoped errors without terminating the Gateway.

I am not proposing a duplicate product patch while the issue is marked `clawsweeper:no-new-fix-pr`. The newly supplied stack still terminates at the generic fs-safe `root()` frame rather than identifying a distinct current-main OpenClaw consumer. If the crash remains reproducible on current `main`, the remaining useful discriminator is a bundle tied to the exact current SHA with the first source-mapped OpenClaw frame above fs-safe root acquisition.
