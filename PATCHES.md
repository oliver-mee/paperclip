# Patches carried on `ome/deploy`

`ome/deploy` is the latest upstream **stable release tag** plus the fixes below, one commit per
fix, cherry-picked (never merged). It is what the omevps Paperclip service runs, installed with:

    paperclipai install --repo oliver-mee/paperclip --ref <ome-tag>

Base: `v2026.916.1` (`d554c4789`).

| Commit subject | Why we carry it | Upstream | State |
| --- | --- | --- | --- |
| `fix(workspaces): honor intentional non-git project paths` | Seats on `non_git_path` project workspaces fail `missing_git_metadata` before they start. | [#13929](https://github.com/paperclipai/paperclip/pull/13929) (supersedes #12205) | open |
| `fix(cli): stage git-ref installs the way release.sh stages packages` | Without it `install --ref` cannot build a working payload, so this branch cannot be installed at all. | [#13928](https://github.com/paperclipai/paperclip/pull/13928) | open |
| `fix(claude-local): discover models with a subscription OAuth token` | Subscription auth never sets `ANTHROPIC_API_KEY`, so the model list was always the static fallback. MAG-445. | none yet | local only |
| `fix(opencode-local): link skills into OpenCode's own skills home` | Pruning in the shared `~/.claude/skills` removed skills that Claude seats rely on. MAG-441. | none yet | local only |
| `fix(ui): serve a fixed-colour favicon URL per colour scheme` | The SVG favicon is cached in whichever colour scheme loaded first, so it can go invisible after a theme switch. MAG-418. | [#14374](https://github.com/paperclipai/paperclip/pull/14374) (fixes #14371) | open |
| `Stop duplicating wake context in adapter environments (#13891)` | The ACPX lane (and every built-in adapter) copied the whole wake payload into `PAPERCLIP_WAKE_PAYLOAD_JSON`; a long thread pushed it past Linux's 128 KiB per-string limit and the seat failed `spawn E2BIG` (Leonard on MAG-380). MAG-451. | [#13891](https://github.com/paperclipai/paperclip/pull/13891) | merged upstream after 916.1; drop on the next rebase |
| `fix: bound launch environments and continuation history against E2BIG` | Guards any other oversized env value and caps the continuation envelope (history, objective, receipts) so long threads stay bounded. Hand-port of four commits onto 916.1. MAG-451. | [#14092](https://github.com/paperclipai/paperclip/pull/14092) | open |
| `fix(cli): stamp the build commit and tag version on git-ref installs` | A git-ref payload has no `.git`, so `/api/health` said `git: unavailable` and the version read `0.3.1`. MAG-451. | extends [#13928](https://github.com/paperclipai/paperclip/pull/13928) | local only |

Not carried, on purpose:

- [#13925](https://github.com/paperclipai/paperclip/pull/13925), dashboard summary regression: test-only, so it changes nothing at runtime.
- [#13923](https://github.com/paperclipai/paperclip/issues/13923), `install --ref` frozen-lockfile abort: only hits `master`. Stable tags have a clean lockfile.
- [#13861](https://github.com/paperclipai/paperclip/issues/13861), `update` misdetects pnpm global installs: we are on the managed install now.

## Updating to a new stable release

    git fetch upstream --tags
    git rebase --onto v<new> v<old> ome/deploy     # rerere is on in the clone
    # drop any commit upstream has merged, then:
    git range-diff v<old>..ome/deploy@{1} v<new>..ome/deploy
    # run the tests named in each commit, update the table above, then tag and install:
    git tag ome-<new>-1 && git push origin ome/deploy --force-with-lease ome-<new>-1
    paperclipai install --repo oliver-mee/paperclip --ref ome-<new>-1

Rollback is `paperclipai install --repo oliver-mee/paperclip --ref <previous ome tag>`.
