# Patches carried on `ome/deploy`

`ome/deploy` is the latest upstream **stable release tag** plus the fixes below, one commit per
fix, cherry-picked (never merged). It is what the omevps Paperclip service runs, installed with:

    paperclipai install --repo oliver-mee/paperclip --ref <ome-tag>

Base: `v2026.916.1` (`d554c4789`).

| Commit subject | Why we carry it | Upstream | State |
| --- | --- | --- | --- |
| `fix(workspaces): honor intentional non-git project paths` | Seats on `non_git_path` project workspaces fail `missing_git_metadata` before they start. | [#13929](https://github.com/paperclipai/paperclip/pull/13929) (supersedes #12205) | open |
| `fix(cli): stage git-ref installs the way release.sh stages packages` | Stages the workspace packages required by `install --ref` and validates that the CLI resolves those staged packages, rejecting nested registry copies. Git installs keep the source package version; the install manifest records the exact ref and SHA. | [#13928](https://github.com/paperclipai/paperclip/pull/13928) | open |
| `fix(claude-local): discover models with a subscription OAuth token` | Subscription auth never sets `ANTHROPIC_API_KEY`, so the model list was always the static fallback. MAG-445. | none yet | local only |
| `fix(opencode-local): link skills into OpenCode's own skills home` | Pruning in the shared `~/.claude/skills` removed skills that Claude seats rely on. MAG-441. | none yet | local only |
| `test(opencode-local): pin HOME in the execute skill-injection tests` | Test-only. Cases without `config.env.HOME` injected (and pruned) skills in the real `~/.config/opencode/skills` (and `~/.claude/skills` before MAG-441). MAG-458. | none yet (upstream master has the same leak, into `~/.claude/skills`) | local only |
| `fix(ui): serve a fixed-colour favicon URL per colour scheme` | The SVG favicon is cached in whichever colour scheme loaded first, so it can go invisible after a theme switch. MAG-418. | [#14374](https://github.com/paperclipai/paperclip/pull/14374) (fixes #14371) | open |
| `Stop duplicating wake context in adapter environments (#13891)` | The ACPX lane (and every built-in adapter) copied the whole wake payload into `PAPERCLIP_WAKE_PAYLOAD_JSON`; a long thread pushed it past Linux's 128 KiB per-string limit and the seat failed `spawn E2BIG` (Leonard on MAG-380). MAG-451. | [#13891](https://github.com/paperclipai/paperclip/pull/13891) | merged upstream after 916.1; drop on the next rebase |
| `fix: bound launch environments and continuation history against E2BIG` | Guards any other oversized env value and caps the continuation envelope (history, objective, receipts) so long threads stay bounded. Hand-port of four commits onto 916.1. MAG-451. | [#14092](https://github.com/paperclipai/paperclip/pull/14092) | open |

Not carried, on purpose:

- [#13925](https://github.com/paperclipai/paperclip/pull/13925), dashboard summary regression: test-only, so it changes nothing at runtime.
- [#13923](https://github.com/paperclipai/paperclip/issues/13923), `install --ref` frozen-lockfile abort: only hits `master`. Stable tags have a clean lockfile.
- [#13861](https://github.com/paperclipai/paperclip/issues/13861), `update` misdetects pnpm global installs: we are on the managed install now.

## 29 September 2026 outage and version-stamping decision

**Verified deployment:** `ome-2026.916.1-4`, commit
`567339ba4577eb25c477b44c033a5bbf42155fdf`, stable base `v2026.916.1`.
It started with native systemd readiness at 19:25:54 HKT. Later documentation and
test-only commits on `ome/deploy` do not change the running payload or require a restart.

### What happened and why stamping was removed

The optional tag-version stamping in `4d76380` changed staged package versions after
the CLI publish manifest had already recorded a concrete server dependency of `0.3.1`.
Tag `ome-2026.916.1-2` (`9822c5a`) consequently loaded an old nested registry server
instead of the fork's top-level server. That caused the different UI, missing routes,
rejected board API key and missing systemd READY signal. The key was valid; it did not
need rotating to restore authentication. This regression was introduced by stamping;
the original fork-install packaging defect and the other functional fixes predated it.

The initial `-3` repair restored matching packages. Oliver then explicitly chose to
remove unnecessary version rewriting rather than maintain it. `567339ba4` removes
tag-to-version parsing and the ineffective commit-stamp file. **Do not reintroduce
stamping just to improve the displayed version.** `0.3.1` and health `commit: null` are
expected source-build reporting: use `repo`, `ref` and `sha` in
`~/.paperclip/cli/install.json` for provenance. Git deployment tags remain useful.

Retain the actual ESM dependency-resolution guard for fresh and cached payloads.
Checking only top-level manifests missed the shadowed server; the guard rejects nested
copies even if their version strings match. The seven functional patch groups remain;
the separate MAG-458 row is test isolation, not another runtime feature.

### Evidence and task handoff

Before activating `-4`: 71 installer/update/service tests passed, followed by a clean
package build, isolated native READY and UI/OpenAPI/document/inbox checks, three non-git
workspace cases, and a 217 KiB wake spawn proof on both adapter lanes. Live board auth,
dashboard/documents and the tailnet issue page passed after the idle restart. MAG-457
subsequently recorded native readiness, no restart loop or reap duplicate-key error,
and successful seat runs. This does not claim a replay of the real MAG-380 conversation.

| Task | Resolved / remaining boundary |
| --- | --- |
| MAG-451 | E2BIG patches and deployment complete; stamping requirement superseded and old `-2` restart request cancelled. Only an explicitly authorised real MAG-380 continuation remains unverified by this repair. Do not port the same patches or request another restart. |
| MAG-452 | Closed after MAG-457 verification. Missing READY came from the wrong server, not evidence that the unit should be changed to `Type=simple`. Investigate sequence collisions only if they recur on a verified current payload; do not repair DB records from the old log alone. |
| MAG-454 | Closed: wrong module resolution caused missing routes. Do not add duplicate routes or reorder middleware to fix historical `-2` failures. |
| MAG-455 | Separate backlog security verification. Existing modern adapter sanitizers dropped a dummy signing-secret value in checks, but that does not prove every fresh agent environment or historical exposure safe. Verify without printing the secret; assess rotation from actual exposure evidence. |

Keep remaining work in backlog until Oliver releases it. Do not reopen completed
incident tasks merely because the displayed version is `0.3.1`.

Never roll back to `-2`: its payload and rollback entry were removed, with diagnostic
manifests preserved under `~/.local/state/paperclip-ops/bad-payload-9822-evidence/`.
Immediate known-good rollback is `-3`; `-1` predates the E2BIG/favicon fixes.

An additional interruption during recovery was caused by two uninstall tests reaching
the real user service manager. Their tests now inject a fake manager. Run service tests
with isolated HOME and an inaccessible user bus; preserve the separate MAG-458 HOME
isolation for OpenCode tests. Do not run destructive CLI tests against the host service.

## Updating to a new stable release

    git fetch upstream --tags
    git rebase --onto v<new> v<old> ome/deploy     # rerere is on in the clone
    # drop any commit upstream has merged, then:
    git range-diff v<old>..ome/deploy@{1} v<new>..ome/deploy
    # run the tests named in each commit, update the table above, then tag and install:
    git tag ome-<new>-1 && git push origin ome/deploy --force-with-lease ome-<new>-1
    paperclipai install --repo oliver-mee/paperclip --ref ome-<new>-1

Rollback is `paperclipai install --repo oliver-mee/paperclip --ref <previous ome tag>`.
