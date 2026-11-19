# Agent-only coding error recovery (DeepSeek Harness comparison)

## Evidence / target

The bounded local agent-failures log for 19 November 2026 recorded
11 failures over the prior two hours: four `edit_block/FILE_CONFLICT`,
four `read_code_file/ENOENT`, two `run_command/COMMAND_FAILED`,
and one `edit_block/EDIT_COUNT_MISMATCH`. These counts describe
**genuine tool outcomes**, not all necessarily MCP transport failures.

DeepSeek Harness's filesystem tools distinguish read-before-edit policy,
stale observations, exact-edit validation, preflighted multi-file patches,
and model-visible correction instructions. See its `packages/fs/tool-fs/README.md`.
BRC already had atomic SHA-256 checks, context patches and path diagnostics;
the main gap was *how the agent used and presented those mechanisms*.

## Changes (local agent only)

- When an `edit_block` call supplies a stale `expected_sha256`, the default
  `BRC_REQUIRE_SOURCE_HASH=auto` mode may refresh its precondition **only**
  if an exact text anchor of at least twelve characters still occurs uniquely
  in the current file. Multi-edits are validated sequentially in memory, with
  a maximum of 20 substitutions. No fuzzy change or whole-file rewrite is
  rebased. The handler still performs its original atomic SHA-256 check
  immediately before publishing. This avoids conflicts after *unrelated*
  external changes without overwriting that unrelated content.
- `BRC_REQUIRE_SOURCE_HASH=1` remains **strict**: a stale caller-supplied
  hash fails, even with a unique anchor. This is intentional when the user
  requires exact prior observation. A short, missing or ambiguous anchor also
  fails in automatic mode.
- Refused stale edits now include a bounded current SHA-256 digest,
  candidate line numbers, count of exact matches and a concrete
  `read_code_file` request in **model-facing text** (not just JSON metadata).
- Exact-match count and missing-text failures also show the existing
  current SHA-256, candidate lines and suggested next read to the model.
  Failures never claim a mutation succeeded.
- For `read_file` and `read_code_file`, an authorized missing path exposes
  the nearest allowed parent, at most five candidate filenames and a specific
  `list_directory` request in visible text. It neither guesses which file to
  read nor changes filesystem permissions.

## What this cannot fix automatically

- An actual compiler/build/test command that exits nonzero remains a genuine
  `COMMAND_FAILED`. Never fake success or blindly replay commands with side
  effects; inspect stderr and exit status.
- `ENOENT` stays a real missing-file result. Suggested filenames may help
  the model correct the path, but the agent does not silently read another
  file with a similar name.
- Concurrent writes that touch the *same* edit anchor, ambiguous substitutions,
  externally changing file permissions and strict hash requirements must
  remain conflicts. Avoiding these errors silently would risk data loss.
- ChatGPT's choice of an incorrect path or command cannot be guaranteed away
  by an MCP executor.

## Safe verification

```sh
pnpm --dir packages/agent build
node --test packages/agent/test/harness-error-recovery.test.mjs \
  packages/agent/test/edit-block-recovery.test.mjs \
  packages/agent/test/source-observations.test.mjs
node --test --test-concurrency=3 --test-reporter=dot packages/agent/test/*.test.mjs
```

All new tests operate only in temporary isolated directories. They never
modify `~/.brc/config.json`, actual user projects, or the relay source.

## Activation

This is **agent-only**. No relay code, authentication, pairing, schema or
public MCP tool contract changed. The running Node agent must restart to load
its rebuilt JavaScript modules. Do not restart while another BRC tool or
plugin process is doing work; choose an idle period. The agent reconnects
outbound using existing pairing — this does not require relay redeployment
or a fresh ChatGPT OAuth connection.
