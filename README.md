# PR #95522 Telegram proof evidence

Public evidence assets for `openclaw/openclaw#95522`.

These clips are derived from the latter half of an operator-provided screen recording of a dedicated Telegram test bot run. Bot token and full chat id are not included.

## Assets

- `evidence/pr-95522/telegram-proof-core.gif` — recommended compact GIF evidence from the corrected late-half segment.
- `evidence/pr-95522/telegram-proof-core.mp4` — clearer MP4 clip of the same corrected window.
- `evidence/pr-95522/telegram-proof-cropped.gif` — longer alternate GIF including more of the surrounding cleanup window.
- `evidence/pr-95522/SHA256SUMS.txt` — checksums for the hosted assets.

## Observed sequence

- Progress placeholder appears first.
- Short opt-in assistant preview appears separately after the bounded delay.
- Final answer is sent separately.
- Transient proof messages are cleaned up.

See `openclaw/openclaw#95522` for the code, review context, and redacted Bot API proof summary.
