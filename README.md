# dsh-llm-opencode-zen

DeepSeek Harness plugins for the **OpenCode Zen free tier**:

- **`dsh-llm-opencode-zen`** — a resilient LLM adapter for the `deepseek-v4-flash-free`
  model, tuned for the realities of a rate-limited free tier.
- **`dsh-harness-updater`** — keeps `@deepseek-ai/dsh` current with one registry check
  per day and an npx-cache warm-up.

## Features

- **Resilient free-tier operation**
  - On `429`, the adapter records a per-session cooldown and surfaces a clear,
    human-readable message instead of blindly retrying (downgrading effort would
    not lift a provider-side limit and only wastes a request).
  - On `402` (Payment Required — free quota exhausted), it is classified as
    `QUOTA`, recorded in the same per-session cooldown, counted in telemetry,
    and retried by the harness after the cooldown elapses. Non-JSON error bodies
    (HTML/plain-text pages) are surfaced verbatim instead of being swallowed.
  - **Proactive pacing** — a rolling per-session request budget (default
    `maxRequests: 3` per `windowMs: 20s`, hold capped at `maxHoldMs: 15s`) slows
    the adapter down *before* the provider's limit is hit, instead of only
    reacting after a 429/402. This converts most limit hits into short waits.
  - The bundled `retryPolicy` lets the harness `llm-retry` layer wait out the
    cooldown and retry the whole turn instead of failing (`RATE_LIMITED` and
    `QUOTA` are both retryable).
  - Per-session cooldown isolation: a new session is never blocked by another
    session's cooldown.
- **Quota & caching telemetry** — per-process usage, cache-hit rate, and per-session
  rate-limit cooldowns persisted to `~/.dsh/storages/llm-opencode-zen-usage.json`
  with debounced writes (cooldowns flush immediately).
- **Lazy usage fallback** — input/output token estimation only runs when the provider
  omits usage, avoiding a full-history scan on every request.
- **Transport retry jitter** — in-flight retries back off 250–500ms instead of
  hammering the same failure.
- **Stable KV-cache prefix** — tools are emitted in a stable order so more requests
  land on the provider's prompt cache (free-tier cache reads are the cheapest tokens).
- **Tool-call JSON repair** — truncated/malformed tool arguments are repaired
  (closure, prefix, backtrack) instead of aborting the agent turn.
- **Concurrency cap** — `maxConcurrentStreams` (default 2) throttles bursty parallel
  agent steps to reduce 429 pressure.
- **Stream idle watchdog** — a stalled upstream is torn down with a clear `TIMEOUT`
  instead of hanging the agent loop.
- **Built output** — minified single-file ESM bundles (`dist/`) for fast loading; shared
  `@deepseek-ai/*` runtime dependencies stay external.

## Install

Requires Node.js ≥ 20.

```sh
npm install
npm run build
npm run install:local   # copies bundles into $DSH_HOME/plugins and points the web profile at dist/
```

Then start dsh with your usual launcher (`dsh web` / `npx @deepseek-ai/dsh web`).

## Configuration

The `llm-opencode-zen` settings section lives under `llm-opencode-zen:` in your
`settings.yaml`. Notable options:

| Key | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `https://opencode.ai/zen/v1` | API endpoint (`OPENCODE_ZEN_BASE_URL` env override) |
| `apiKeyEnv` | `OPENCODE_ZEN_API_KEY` | credential env for higher limits; free tier uses literal `public` |
| `thinking` | `enabled` | reasoning support |
| `reasoningEffort` | — | `off` / `low` / `high` / `max` |
| `maxConcurrentStreams` | `2` | in-flight stream cap |
| `streamIdleTimeoutMs` | `300000` | stalled-stream timeout |
| `pacing` | `{enabled:true, maxRequests:3, windowMs:20000, maxHoldMs:15000}` | rolling per-session request budget; waits before the provider limit is hit |
| `retryPolicy` | bundled | `RATE_LIMITED`/`QUOTA`/`TIMEOUT`/`TRANSPORT`/`STREAM_CLOSED` retryable, 60s max delay |
| `models` | `deepseek-v4-flash-free` | model catalog (context window, max tokens) |

## Development

```sh
npm run build   # esbuild minify -> dist/
```

Runtime deps (`@deepseek-ai/dsh-llm`, `dsh-credentials`, `dsh-settings`, `dsh-timeout`,
`dsh-launch-environment`, `schemastery`, `eventsource-parser`) are external and resolve
from the installed plugin directory, so the adapter always speaks the same `LlmAdapter`
brand as the harness.

## License

MIT