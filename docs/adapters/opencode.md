---
title: OpenCode
summary: OpenCode local adapter setup and configuration
---

The `opencode_local` adapter runs the OpenCode CLI as a subprocess and parses its
`run --format json` JSONL output. The adapter lives in
[`packages/adapters/opencode-local`](../../packages/adapters/opencode-local) and
supports local execution targets as well as remote SSH and sandbox targets.

## Prerequisites

OpenCode installed as `opencode` (either supported line below), or the binary
path set via `adapterConfig.command`, plus credentials for the configured
provider (for example an `OPENAI_API_KEY` in `adapterConfig.env` or an existing
OpenCode provider login).

```sh
# OpenCode v1 — npm package `opencode-ai`
npm i -g opencode-ai

# OpenCode v2 — npm package `@opencode/cli`
npm i -g @opencode/cli
```

Official installers as of 2026-09: `https://opencode.ai/install` currently ships
the v1 line (upstream GitHub releases are still v1.x tags), while
`https://opencode.ai/v2/install` installs v2. Both lines install the same
`opencode` binary name. Managed sandbox targets bootstrap with the official v1
installer, so run v2 on a remote target by baking `@opencode/cli` into the
target and pointing `adapterConfig.command` at that binary.

## Supported OpenCode Lines

| | v1 | v2 |
|---|---|---|
| npm package | `opencode-ai` | `@opencode/cli` |
| Supported range | 1.18.x | 2.0.x |
| Tested version | 1.18.32 | 2.0.18 (tested floor) |
| Install | `npm i -g opencode-ai` | `npm i -g @opencode/cli` |
| Headless approval | runtime config `permission=allow` | runtime config plus `--auto` |
| Model + variant | `--model provider/model` + `--variant` | `--model provider/model#variant` |
| Skills home | `~/.claude/skills` | `~/.config/opencode/skills` |

One adapter drives both lines — no separate adapter type is needed.

## Version Detection

Before each run the adapter executes `<command> --version` as a local child
process with a bounded timeout (capped at five seconds, so a hung probe never
consumes the run budget). The two lines print different shapes:

- v1 prints a bare version: `1.18.32`
- v2 prefixes it: `opencode v2.0.18`

The output is parsed tolerantly line by line, so a noisy banner still yields the
version. `major >= 2` classifies as v2, `1.x` as v1; anything else — including a
missing command, a timeout, or unparseable output — resolves to `unknown`, logs a
notice, and keeps the legacy v1 arguments instead of failing the run.

Override the probed binary with `adapterConfig.command` (defaults to
`opencode`) — useful for an absolute path, a version manager wrapper, or a
second installed line.

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | Yes | OpenCode model in `provider/model` format (for example `anthropic/claude-opus-5`) |
| `variant` | string | No | Reasoning/profile variant (for example `minimal`, `high`, `max`); passed as `--variant` on v1 and folded into the model string on v2 |
| `command` | string | No | Binary to execute (default: `opencode`) |
| `autoApprove` | boolean | No | Pass `--auto` on v2 runs so permission requests are approved instead of auto-rejected in non-interactive mode (default: `true`; ignored by v1) |
| `dangerouslySkipPermissions` | boolean | No | Inject a runtime OpenCode config with `permission=allow` for all tools and connections (default: `true` for unattended runs) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `instructionsFilePath` | string | No | Absolute path to a markdown instructions file prepended to the prompt |
| `extraArgs` | string[] | No | Additional CLI args appended after the adapter's own flags |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |

## Behavior Differences That Matter

- **v2 argv.** v2 runs execute `run --format json --standalone`; `--print-logs`
  is a global flag and is placed before `run`. `--standalone` keeps the run
  private to the process — without it, v2's shared background service cancels
  stdin prompt delivery.
- **Auto-approval.** v2 auto-rejects permission requests in non-interactive mode
  unless `--auto` is passed, so the adapter passes it by default. Set
  `adapterConfig.autoApprove: false` to opt out; the injected
  `permission=allow` runtime config (`dangerouslySkipPermissions`) still applies
  because v2 normalizes v1 config shapes.
- **Model + variant.** v2 rejects a separate `--variant` flag. The adapter folds
  the variant into the model value as `provider/model#variant` (a model that
  already carries a `#suffix` is passed through unchanged).
- **Skills.** Paperclip skills are linked into `~/.claude/skills` on v1 and into
  OpenCode's native `~/.config/opencode/skills` on v2 (which also reads
  `~/.claude/skills` as a lower-precedence compat source). When the line is
  `unknown`, both homes are linked so a run works whichever line is installed.
- **State isolation.** v2 stores state in SQLite (defaulting to
  `~/.local/share/opencode/opencode.db`). The adapter pins `OPENCODE_DB` to the
  run's isolated managed home so a v2 run can never fall back to the operator's
  global database. `OPENCODE_DISABLE_PROJECT_CONFIG=true` is set on both lines
  so OpenCode never writes an `opencode.json` into the project working
  directory.

## Session Persistence

The adapter persists OpenCode session IDs between heartbeats and resumes them
with `--session` when the stored session's cwd matches the current cwd. If
resume fails with an unknown-session error, the adapter automatically retries
with a fresh session.

## Skills Injection

The adapter symlinks Paperclip skills into the skills home for the detected
version line (see [Behavior Differences That Matter](#behavior-differences-that-matter)).
Existing user skills are not overwritten, and skill directory names stay stable
across both homes because v2 derives skill IDs from the path.

## Limitations

Honest current limits of the v2 support:

- **Remote targets stay on the v1 argv.** The version probe runs as a local
  child process, so it is skipped for remote execution targets — the local
  binary is not the one that executes there. Until a remote-aware probe exists,
  remote runs keep the legacy v1 CLI arguments.
- **The runner's OpenCode server driver is still v1.** The paperclip-runner
  OpenCode server driver
  ([`opencode-server-driver.ts`](../../packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts))
  remains pinned to the qualified v1 release 1.18.32 and refuses other versions;
  v2 support covers the `opencode_local` adapter path, not that driver.
- **v2 token usage can read zero.** Usage and cost arrive on the `step_finish`
  event, which v2 text-only runs may never emit — such runs report zero token
  usage rather than an error. Runs that execute tools do emit `step_finish` with
  the same `tokens`/`cost` shape v1 uses.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Working directory is valid and available (auto-created if missing and permitted)
- The configured `command` is executable and resolvable (skipped when working directory validation fails)
- The model is a valid `provider/model` id and is available — discovered from `opencode models` locally, or validated by the probe inside remote targets
- A live hello probe using the same version-aware argv as a real run (including `--standalone` and `--auto` on v2); the local version probe is skipped for remote targets, and the hello probe runs inside the target environment
- An `OPENAI_API_KEY` override that is set but empty warns instead of passing silently

## Next Steps

- [Adapters Overview](overview.md) — how adapters fit into the heartbeat lifecycle
- [Creating an Adapter](creating-an-adapter.md) — shared adapter internals (execute, parse, capabilities)
