# PR 101911 Real Android Actions Media Proof

PR: https://github.com/openclaw/openclaw/pull/101911
PR head under test: `850390a4a6fbcd6cbd6aca627afe3cf98c53d0fc`
Proof run: https://github.com/snowzlmbot/openclaw/actions/runs/28916953640
Proof repo: `snowzlmbot/openclaw`
Proof workflow: `Android language proof`
Proof target ref: `evidence/pr-101911-real-android-proof`
Proof branch relationship: proof branch contains latest PR head `850390a4a6fbcd6cbd6aca627afe3cf98c53d0fc` plus proof-only workflow/screenshot-scene files.
Artifact: `android-language-proof-en`

## Real capture details

This media was captured by GitHub Actions in `snowzlmbot/openclaw` on a GitHub-hosted Ubuntu runner using an Android API 35 emulator. The workflow reused cached Android SDK/Gradle setup where available, checked out a proof branch based on the latest PR head, built the Android Play debug APK, launched the installed Android app through the repository's Android screenshot capture harness, and uploaded the generated screenshot artifact.

The proof-only branch adds a deterministic `skill-workshop` screenshot scene so the runner can capture Android media for the new Settings > Skill Workshop surface without changing the upstream PR code branch. The PR branch contains the production implementation and the admin-scope quality fix.

## Media

- `real-actions-openclaw-skill-workshop-latest-head.png`: real GitHub Actions Android emulator screenshot for the Skill Workshop proof scene.
