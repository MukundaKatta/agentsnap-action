# agentsnap-action

[![Marketplace](https://img.shields.io/badge/Marketplace-agentsnap--action-purple?logo=github)](https://github.com/marketplace/actions/agentsnap-action)
[![CI](https://github.com/MukundaKatta/agentsnap-action/actions/workflows/test.yml/badge.svg)](https://github.com/MukundaKatta/agentsnap-action/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Snapshot tests for AI agent tool-call traces. Wraps the npm-published [`@mukundakatta/agentsnap`](https://www.npmjs.com/package/@mukundakatta/agentsnap) library.

The action diffs each `*.snap.json` baseline in your snapshots dir against a sibling `*.current.json` (produced by your test run earlier in the workflow via `record()`) and fails the PR on drift. On drift, posts a Markdown summary as a PR comment.

## Quick start

```yaml
- uses: actions/checkout@v4
- run: npm test          # your tests must record a *.current.json next to each *.snap.json
- uses: MukundaKatta/agentsnap-action@v1
```

## How it works

1. Your test calls `record(fn)` from `@mukundakatta/agentsnap` and writes the trace to `tests/__agentsnap__/<name>.current.json`.
2. This action looks for `tests/__agentsnap__/<name>.snap.json` (the baseline) and runs `diff()`.
3. If the diff status is in `fail-on-drift`, the action fails the workflow.
4. If `comment-on-pr` is `true` and the event is a PR, the action posts a drift summary as a PR comment.
5. Set `update-snapshots: true` to overwrite baselines instead of failing — useful for the "I changed the prompt on purpose" case.

## Inputs

| Input | Default | Description |
|---|---|---|
| `snapshots-dir` | `tests/__agentsnap__` | Directory containing `*.snap.json` baselines and `*.current.json` runs. |
| `update-snapshots` | `false` | If `true`, overwrite baselines with the current run instead of diffing. |
| `fail-on-drift` | `OUTPUT_DRIFT,TOOLS_CHANGED,REGRESSION` | Comma-separated drift statuses that fail the build. |
| `comment-on-pr` | `true` | Post a Markdown summary on the PR when drift is detected. |
| `report-path` | `agentsnap-report.json` | Where to write the JSON diff report. |
| `node-version` | `20` | Node version for the runner. |

## Drift statuses

| Status | Meaning |
|---|---|
| `PASSED` | bytewise structural match |
| `OUTPUT_DRIFT` | tool sequence + args identical; output text or result hashes differ |
| `TOOLS_REORDERED` | same tools called, different order |
| `TOOLS_CHANGED` | different tools or different args |
| `REGRESSION` | a new error appeared (top-level or per-tool) |

## Outputs

| Output | Description |
|---|---|
| `total-snapshots` | Number of `*.snap.json` files checked. |
| `drift-count` | Number that drifted (any non-PASSED status). |
| `report-path` | Path to the JSON report. |

## Permissions

To post PR comments, the workflow needs:

```yaml
permissions:
  pull-requests: write
  contents: read
```

## Example: full agent test run with snapshot gate

```yaml
name: Agent regression
on: pull_request

permissions:
  pull-requests: write
  contents: read

jobs:
  agentsnap:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test    # writes tests/__agentsnap__/*.current.json
      - uses: MukundaKatta/agentsnap-action@v1
        with:
          snapshots-dir: tests/__agentsnap__
          fail-on-drift: REGRESSION,TOOLS_CHANGED
```

## Sibling actions

Part of the [@mukundakatta agent stack](https://www.npmjs.com/~mukundakatta):

- [`agentvet-action`](https://github.com/MukundaKatta/agentvet-action) — lint LLM tool definitions
- [`mcp-stack-validate-action`](https://github.com/MukundaKatta/mcp-stack-validate-action) — single CI gate that runs the whole stack

## License

MIT
