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

## Updating to a new stable release

    git fetch upstream --tags
    git rebase --onto v<new> v<old> ome/deploy     # rerere is on in the clone
    # drop any commit upstream has merged, then:
    git range-diff v<old>..ome/deploy@{1} v<new>..ome/deploy
    # run the tests named in each commit, update the table above, then tag and install:
    git tag ome-<new>-1 && git push origin ome/deploy --force-with-lease ome-<new>-1
    paperclipai install --repo oliver-mee/paperclip --ref ome-<new>-1

Rollback is `paperclipai install --repo oliver-mee/paperclip --ref <previous ome tag>`.
