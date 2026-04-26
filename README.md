# Horizon Context Memory

**Horizon Context Memory** is a local-first memory and self-evolution layer for Codex-style agent workflows.

The public command is intentionally short:

```bash
hcm
```

`hcm` expands to **Horizon Context Memory**. It opens a local web cockpit where you can inspect, search, enable, disable, edit, and delete the memories that the agent has accumulated automatically.

## Why it exists

Agent memory is useful only when it is durable, selective, and reversible. HCM is designed around that constraint:

- **Automatic capture**: Codex hook events are recorded and mined for durable preferences, project rules, workflows, tools, and failure lessons.
- **Conservative promotion**: memory candidates are scored before they become active context.
- **Deep recall**: the memory pool stores thousands of entries but injects only the most relevant memories per turn.
- **Web-first management**: daily control happens in the browser, not through a long command list.
- **Reversible cleanup**: LLM review, dedupe, merge, disable, and restore actions are audited.
- **Local-first storage**: memory data stays on your machine under `~/.codex/hcm/data`.

## Quick start

```bash
git clone https://github.com/logcjj/horizon-context-memory.git
cd horizon-context-memory
./install.sh
```

Restart your terminal, then run:

```bash
hcm
```

The cockpit opens at:

```text
http://127.0.0.1:38987
```

## Daily usage

Use the web cockpit for normal work:

| View | Purpose |
| --- | --- |
| `All` | Browse and search all memories. |
| `USER` | Personal preferences that should follow you across projects. |
| `MEMORY` | Project rules, workflows, tools, environments, and lessons. |
| `Pending` | Disabled items, review candidates, conflicts, low-quality memories, and cleanup suggestions. |

The important actions are available per memory card:

- `Enable` / `Disable`: choose whether a memory participates in recall.
- `Details`: inspect scope, type, lifecycle, quality, and usage.
- `Evidence`: see why the memory exists.
- `Edit`: correct an inaccurate memory.
- `Delete`: remove a memory when it should not be kept.

## How automatic memory works

HCM has two generated memory mirrors:

```text
~/.codex/hcm/data/USER.md
~/.codex/hcm/data/MEMORY.md
```

The structured source of truth is:

```text
~/.codex/hcm/data/memories.json
```

A typical loop is:

1. Codex emits hook events during normal usage.
2. HCM records prompts, sessions, and tool activity locally.
3. Candidate extraction identifies durable facts and preferences.
4. Scoring rejects weak or transient candidates.
5. Active memories are ranked during recall and injected as context.
6. Maintenance jobs merge duplicates, audit lifecycle state, rebuild search, back up data, and prepare review items.

Default depth profile:

```text
Stored memories: 5000
Enabled memories: 2000
Per-turn recall: 24
Captured prompt/tool text: 4000 chars
```

## Codex integration

After installation, the hook wrapper lives at:

```text
~/.codex/hcm/bin/codex-hook-wrapper
```

Wire that wrapper into your Codex hook configuration to enable automatic capture and context injection. If `oh-my-codex` native hooks are installed, HCM preserves and merges their hook output instead of replacing it.

## Local architecture

```text
bin/hcm                  opens the local web cockpit
bin/hcm-core             internal engine for hooks, recall, review, and diagnostics
bin/codex-hook-wrapper   Codex hook bridge
web/server.js            local-only HTTP API on 127.0.0.1
web/index.html           single-file cockpit UI
data/                    local memories, events, audit log, backups, and search index
```

See `ARCHITECTURE.md` for the implementation model.

## Safety model

- HCM treats memory as advisory context, not verified truth.
- Repository facts should still be checked against current files before action.
- Sensitive-looking values are blocked or redacted by the capture layer.
- Destructive review suggestions disable memories first instead of hard-deleting them.
- Skill proposals are generated as candidates and are not auto-installed by default.

## Status

This is an early open-source release focused on the memory and self-evolution layer: capture, quality scoring, deep recall, lifecycle maintenance, local web management, and auditability.

## License

MIT

## Disclaimer

Horizon Context Memory is independent software. It is not affiliated with Hermes, Codex, OpenAI, Anthropic, OMO, or any other agent-memory project.
