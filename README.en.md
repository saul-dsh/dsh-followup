# dsh-followup

[![CI](https://github.com/saul-dsh/dsh-followup/actions/workflows/ci.yml/badge.svg)](https://github.com/saul-dsh/dsh-followup/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Smart follow-up suggestions for DeepSeek Harness (dsh): **after every assistant turn, 2-3 clickable follow-up prompts float above the composer** — the same interaction as Trae's "smart follow-up recommendations".

## What it looks like

- About 1-2 seconds after a reply settles, chips appear above the input box:

  ```
  [ Write option 2, but add more of the male lead → ]  [ Start with option 1 → ]  ↻  ✕
  ```

- **Click a chip**: the full sentence is placed into the draft for editing — **never auto-sent**
- **↻ refresh**: regenerate from the same turn's context
- **✕ dismiss**: hide for this turn
- Chips disappear as soon as you type or send

## How it works

1. The server side assembles the tail of the latest turn from read-only runtime events: user text from `agent/pre-step`, assistant text accumulated from `agent/assistant-stream`, and turn settlement from `agent/status → idle` (with a 1.2s buffer so intermediate idles in multi-step tool turns are discarded).
2. A lightweight `ctx.llm.stream` call runs through dsh's own model routing (follows the session's model, or a fast model configured on the plugin): context trimmed to 400 user chars + 1200 assistant chars, output capped at 220 tokens, strict JSON required.
3. Results are cached with a monotonic `seq`; the client fetches on every busy→idle transition and ignores stale seqs.

Safety posture: **read-only, never modifies messages, never intercepts sending, fail-silent** — timeouts, missing routes and parse failures all quietly skip the turn.

## Install

```sh
dsh plugin --profile web add /absolute/path/to/dsh-followup
dsh plugin --profile desktop add /absolute/path/to/dsh-followup
```

Restart dsh. No API key configuration needed — generation reuses the credentials dsh already has.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | master switch |
| `provider` / `model` | follow session | model used to generate suggestions; a fast model is recommended |
| `timeoutMs` | `12000` | per-generation timeout |
| `idleDelayMs` | `1200` | buffer after a turn settles |
| `maxSuggestions` | `3` | max chips (2-3) |
| `userChars` / `assistantChars` | `400` / `1200` | context trimming limits |
| `minAssistantChars` | `30` | skip very short replies |

## Troubleshooting

- **No chips**: confirm the reply actually finished and is longer than 30 chars; check server logs for `[dsh-followup] turn N: N suggestions`. Log present but no chips → client side (search `[dsh-followup]` in DevTools). No log → server never triggered; check `minAssistantChars` and the model route.
- **Poor suggestions**: point `provider` + `model` at a stronger model.
- **Tool-heavy turns**: no chips while tools run, only after the whole turn settles — by design.

## License

[MIT](LICENSE)
