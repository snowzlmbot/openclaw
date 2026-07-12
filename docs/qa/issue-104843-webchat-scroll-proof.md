# Issue #104843 WebChat Scroll Proof

This evidence-only workflow compares the reported `2026.6.11` release with the latest upstream
`main` in a real Chromium browser on GitHub Actions.

The browser test:

1. Loads a long WebChat history through the repository's Mock Gateway.
2. Uses the visible Control UI settings to select `Auto-scroll: Always`.
3. Sends a chat turn through the real composer.
4. Emits 480 accumulated assistant deltas at two-millisecond intervals.
5. Samples `.chat-thread` geometry on every animation frame while recording Playwright video.
6. Fails when the transcript remains more than 240 pixels from the bottom for six consecutive
   animation frames during the active stream.

Every matrix lane uploads:

- continuous Playwright video (`.webm`, plus `.mp4` when `ffmpeg` is available);
- `scroll-samples.json` with animation-frame geometry;
- `proof-result.json` with the exact candidate SHA and verdict;
- a full-page final screenshot;
- the complete Vitest log and a concise Markdown summary.

The harness is for reproduction and evidence only. It does not change production behavior.
