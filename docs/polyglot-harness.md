# Multilingual coding harness and context graph

## Architecture

The agent runs parsers, ripgrep, file edits, project discovery, checks, context assembly and the dependency metadata graph on the controlled computer. The relay authenticates clients, lists permitted devices/tools, routes calls and enforces transport limits. This is a deterministic tool harness, not another AI model or a Claude/Codex subscription.

No graph database is installed. The new graph is an agent-local RAM cache; it is not stored in the relay SQLite database. SQLite still holds operational accounts, device pairings and valid credentials. Activity logs, transcripts, tool results and graph snapshots are not persisted by BRC.

The graph in the linked course describes workflow orchestration: responsibilities, handoffs, conditions, verification and recovery. A code dependency graph is a different structure. BRC uses both ideas narrowly: existing coding-session gates control the workflow, while the new file/import graph helps the model find relevant source.

## Language support is explicit

All ordinary UTF-8 text languages can use text search, exact range reads, full-file hashes, ranged edits and generic context tools. Existing file tools remain available for encodings/formats not accepted by code snapshots.

| Provider | Languages | What is available |
| --- | --- | --- |
| TypeScript parser | JS, JSX, TS, TSX and common module extensions | Syntax declarations/imports, exact ranges, syntax diagnostics and guarded symbol replacement. |
| Portable Tree-sitter WASM | C#, Rust, Python, Go, Java, C, C++, Ruby, PHP, Swift, Dart, Solidity, CSS and Vue | Syntax trees, supported declaration/import nodes, diagnostics and guarded replacements where an exact declaration is available. |
| Generic fallback | F#, VB, Kotlin, Scala, shell, project files and unknown text languages | Literal search, exact text ranges, hash-checked edits and labeled declaration/import candidates. No claim of grammar validation or safe AST replacement. |

C# is parser-backed. F# and VB remain generic for syntax navigation, but `.fsproj`/`.vbproj` projects participate in .NET check discovery and project references. No language server, compiler symbol binding, macro expansion, whole-program call graph, unsaved VS Code buffer or automatic semantic rename is provided.

A registered grammar does not mean every declaration construct has an extraction adapter. For example, a Vue container can be parsed without extracting declarations inside every embedded language. `language_capabilities`, `provider`, `syntaxSupported` and per-symbol metadata expose these boundaries. `replace_symbol` rejects generic, incomplete or syntactically invalid trees. Unknown-language diagnostics say `checked: false` rather than reporting a false pass.

## Tools

The default full profile exposes 70 agent tools plus the relay's `list_devices` (71 total). Existing tools were extended rather than duplicated for each language.

- `language_capabilities`: exact parser/text capabilities, parser cache and graph status.
- `code_graph`: query/refresh/status/clear a bounded file/import metadata graph; traverse dependencies or importers.
- `context_pack`: one budgeted response with scoped guidance, declarations, fresh code snippets/hashes and relationship candidates.
- `session_handoff`: current goal, scope, changes and verification evidence from a live coding session. Nothing is saved automatically.

`code_outline`, `find_symbols`, `read_symbol`, `replace_symbol`, `code_diagnostics`, `find_references` and `related_files` no longer reject a project merely because it is not JS/TS. Text reference candidates are not semantic references. `related_files` uses confidence labels:

- `path`: a local candidate path exists in the scanned subset.
- `module-candidate`: Python/Rust/Go module conventions suggest a local target.
- `namespace-candidate`: C#/Java/PHP namespace or package declarations suggest targets.
- `lexical-candidate`: generic text patterns suggest a relationship.

C#/Java namespace candidates can be ambiguous. External packages, aliases, generated code, dynamic imports and dependencies outside the scan remain explicitly unresolved. An absent edge does not prove no dependency exists. `.csproj`/`.fsproj`/`.vbproj` project references and `.sln`/`.slnx` project paths are recognized without executing MSBuild or expanding XML entities.

## Context-cache behavior

At most four graph roots are held in RAM. Each build defaults to 300 files and accepts up to 1,500, with an enumeration cap of 15,000 filenames, a 20-second scheduling budget, a 16 MiB source-read budget and a 4 MiB serialized-node metadata budget. Two readers/parser jobs run at once. Queries explicitly identify partial output. This is not a claim that total process RSS is 4 MiB.

Unchanged files reuse metadata after checking size, mtime, ctime and inode. Changed files are reparsed; deleted/unreadable files do not retain old graph entries. A watcher invalidates enumeration, with a five-second fallback refresh; explicit `refresh` forces source rereads. Timestamp metadata is a performance hint, not an edit precondition: code reads return fresh content hashes, and edits recheck those hashes.

Graph nodes contain metadata, not full source files. A separate parser-result RAM cache is capped at 32 entries/4 MiB of estimated retained source and syntax metadata and uses fresh file hashes. Tree-sitter work runs in a lazy one-worker pool (optionally two via BRC_PARSER_WORKERS) with a 16-job queue, an eight-second per-job budget, cancellation, idle termination and periodic recycling. V8 worker limits do not bound every WASM/native allocation, so overall RSS must still be observed.

`context_pack` has a compact serialized payload budget, defaults to 20,000 characters, and supports up to 48,000. It reads snippets fresh after graph selection, prioritizes the focused file, and never invokes an additional model or embedding service. Large projects should use a narrower root or focused query instead of treating a truncated graph as complete.

Ignored dependency/build directories remain excluded. Rust `src/bin` is not mistaken for a generated directory; common .NET `bin/Debug`, `bin/Release` and `obj` output is excluded.

## Claude/Codex-style guidance

Project guidance is read from the supplied root down to the focused directory. In each directory, the first non-empty `AGENTS.override.md` or `AGENTS.md` supplies Codex-style guidance. Nested `CLAUDE.md`, `.claude/CLAUDE.md` and bounded `.claude/rules/*.md` guidance are also considered.

The rule reader supports common scalar, quoted-list and block-list `paths` frontmatter, with bounded glob expansion. It is deliberately not a general YAML processor or a complete replica of either CLI. Only matching path-scoped rules are included. Global home-directory memories, `@` imports, hooks, skills and arbitrary settings commands are not loaded/executed automatically. Unsupported rule patterns are reported rather than treated as globally applicable.

Instructions are task context, not an authorization layer. Existing allowed-directory checks and user approval remain authoritative. No repository text can authorize broader filesystem access or secretly run setup scripts.

## Cross-language checks

`discover_checks` inspects existing manifests. `run_project_checks` previews selected IDs unless `execute: true` is supplied. Coding-session verification explicitly runs the declared required checks.

| Manifest/ecosystem | Examples of discovered checks |
| --- | --- |
| package.json | Existing test/lint/typecheck/build/custom scripts; watch/dev/server modes are excluded. |
| .NET solution/project | `dotnet:build`, `dotnet:test`, with `--no-restore`; multiple projects receive distinct IDs. |
| Cargo.toml | `cargo:check`, `cargo:test`, `cargo:fmt`; check/test are offline. |
| go.mod | `go:test`, `go:vet`; module-network resolution disabled in the runner environment. |
| Python test manifests | `python:test` using an identified pytest setup or unittest discovery. |
| Maven/Gradle | Offline test recipes requiring installed tools. |
| CMake, Swift, Dart/Flutter | Manifest-backed build/test candidates with required toolchains stated. |

Toolchains and dependencies must already be installed. Discovery does not install compilers, restore packages or execute build files. Explicitly executed build/test scripts can run project code and create normal project artifacts; offline flags are not an OS network sandbox. Exit code zero proves only that the selected command succeeded, not that it discovered meaningful tests or established complete correctness.

`verify_project` also accepts an explicit `program` and argument array instead of a shell command. Arguments are passed literally without shell interpolation. This path has the same bounded output, cancellation and real exit-status handling. Arbitrary approved commands remain available through the existing terminal tools.

## Relay changes

The relay caches transformed tool schemas, not authorization. Ownership, online/paused state and current device descriptors are rechecked for every listing; reconnects and changed capabilities invalidate the transformation cache. The cache is limited to 128 users per hub.

The relay permits at most 64 outstanding calls per device and 512 total. Calls are refused before dispatch when the socket is closed, its outbound buffer exceeds 8 MiB or arguments exceed 16 MiB. Mutations are never automatically replayed after an uncertain disconnect. Last-seen database writes are coalesced to at most one every five seconds per device; token validity/revocation is not cached by this optimization.

## Verification and benchmarking

Run from the repository root:

```powershell
pnpm build
pnpm typecheck
pnpm test
node scripts/benchmark-context.mjs
```

The benchmark creates 120 small C# fixtures in a temporary directory, measures cold/warm graph calls and a one-file change, prints results only to stdout, and removes its fixtures. It measures local graph work, not remote RTT, model generation time or a guaranteed production speedup.

Tests cover language grammars, Unicode ranges, C#/Rust/Python edits, generic safety boundaries, module/project references, cache invalidation, scoped guidance, literal arguments, relay freshness/backpressure, no persisted logs and the actual HTTP MCP/WebSocket transport. Native compiler execution across all listed ecosystems is not implied by parser/discovery tests.

Rebuild/restart the local agent to activate the compiled source. Rebuild/redeploy the relay separately for its optimizations. No source change automatically updates a VPS, publishes an npm release, commits code or changes a Windows startup registration.

## Research sources and adaptations

- [Learn Harness Engineering](https://github.com/walkinglabs/learn-harness-engineering): instructions, scope, state, verification and lifecycle. These concepts inform deterministic tools and completion gates, not additional autonomous model calls.
- [Lecture 14: Graph Engineering](https://github.com/walkinglabs/learn-harness-engineering/blob/main/docs/en/lectures/lecture-14-graph-engineering/index.md): explicit workflow responsibility/routing and orchestration cost. It does not require a graph database; the source dependency cache is BRC's separate implementation choice.
- [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/): repository knowledge, concise navigation and mechanically verifiable feedback. Applied through scoped context, evidence and budgets rather than an enormous prompt.
- [Codex AGENTS.md guidance](https://developers.openai.com/codex/guides/agents-md): per-directory overrides and root-to-focus guidance. BRC implements project-local discovery only, not every Codex setting.
- [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): just-in-time relevant context and clear, non-overlapping tools. Applied through context packs and narrowed graph queries.
- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): incremental work and explicit handoffs. BRC deliberately uses RAM-only handoffs rather than the article's persistent progress log.
- [Claude Code memory and rules](https://code.claude.com/docs/en/memory): scoped CLAUDE.md and paths-based rules. No automatic memory writing or hook execution is enabled.
- [Tree-sitter web binding](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md) and [Repomix grammar bundle](https://github.com/repomix/tree-sitter-wasms): portable syntax infrastructure. Grammar availability is not semantic-language-server support.

## Faster batches, infrastructure and images

See [the fast-agent guide](fast-agent.md) for 64-call read waves/write barriers, combined workspace edits/readback/checks, Docker observation, actual image previews, optional restricted execution, automatic cache eviction and `pnpm bench:io`. Diagnostics remain live-only. These tools do not add another model or a graph database.

## Optional host-native worker coordination

See [the parallel-worker guide](parallel-workers.md) for `worker_tasks`, `worker_patch`, and `worker_integrate`. Native AI workers, when the host actually supports them with BRC access, can claim independent scopes and submit patches without directly editing shared source. One parent integrates and verifies. Hosts without native workers keep ordinary batches; no model/API calls are added. `workspace_batch` also supports optional 1-4-way distinct-file publication with settled-wave rollback. Diagnostics and coordinator state remain live-only/RAM-only.
