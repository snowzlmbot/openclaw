Confirmed: the published [`v2026.7.1-beta.5`](https://github.com/openclaw/openclaw/releases/tag/v2026.7.1-beta.5) release **does carry** the lazy-root fix from #89226.

Traceability evidence:

- beta.5 release commit: `b6387afd6d2e0f43c2ae98d2d124dbc277f03cca`
- #89226 merge commit: `201686d9e30dbc85790f3e5c851a57e4d96d233e`
- `git merge-base --is-ancestor 201686d9e30d b6387afd6d2e` succeeds; the fix is 2,825 commits behind the beta.5 release commit.
- The tag-pinned source contains the lazy, memoized `getRoot()` implementation for both host write and edit operations: [`agent-tools.read.ts`](https://github.com/openclaw/openclaw/blob/v2026.7.1-beta.5/src/agents/agent-tools.read.ts#L1028-L1085).
- The tag also contains the dedicated missing-workspace regression: [`agent-tools.read.workspace-root-lazy.test.ts`](https://github.com/openclaw/openclaw/blob/v2026.7.1-beta.5/src/agents/agent-tools.read.workspace-root-lazy.test.ts).
- The matching npm package is published as [`openclaw@2026.7.1-beta.5`](https://www.npmjs.com/package/openclaw/v/2026.7.1-beta.5); its registry integrity matches the release verification section.

One release-note detail is worth calling out: PR `#89226` is not listed explicitly by number in beta.5's generated **Complete contribution record**. That record describes a bounded generated history range and is not authoritative for this cross-branch ancestry case. The immutable tag ancestry and tag-pinned source above are the stronger proof that the shipping package contains the change.

So beta.5 is available now as a concrete release for re-testing. If the same process exit still occurs on `2026.7.1-beta.5`, a stability bundle from that exact version would separate a remaining caller from the eager write/edit root path already fixed by #89226.
