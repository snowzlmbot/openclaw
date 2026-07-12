# Issue #104843 WebChat Scroll Proof

This evidence-only workflow compares the reported `2026.6.11` release with the latest upstream
`main` in real Chromium browsers on GitHub-hosted Ubuntu and macOS runners.

The browser test:

1. Loads a 140-message WebChat history through the repository's Mock Gateway.
2. Uses the visible Control UI settings to select `Auto-scroll: Always`.
3. Sends three chat turns through the real composer: a two-millisecond burst, a stream that crosses
   animation-frame and 120/150ms retry boundaries, and a delayed final response shaped like the
   extra processing latency reported with streaming TTS.
4. Alternates incomplete fenced Markdown, tables, long paragraphs, and final rerenders.
5. Samples `.chat-thread` geometry and node identity on every animation frame while recording
   continuous Playwright video.
6. Fails on a painted bottom-to-top jump or when the transcript remains more than 240 pixels from
   the bottom for six consecutive animation frames during the active stream.

Every matrix lane uploads:

- continuous Playwright video (`.webm`, plus `.mp4` when `ffmpeg` is available);
- `scroll-samples.json` with animation-frame geometry;
- `proof-result.json` with the exact candidate SHA and verdict;
- a full-page final screenshot;
- the complete Vitest log and a concise Markdown summary.

The harness is for reproduction and evidence only. It does not change production behavior.
It exercises the WebChat streaming/render timing path but does not claim to run a real TTS provider
or media attachment pipeline.
