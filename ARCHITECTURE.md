# Architecture

Horizon Context Memory has three layers.

## Capture

`bin/hcm-core hook` receives Codex hook payloads. It records prompt, session, and tool events under `data/events/*.jsonl`, builds a local SQLite search index when available, and extracts durable memory candidates.

## Memory pool

`data/memories.json` is the source of truth. `USER.md` and `MEMORY.md` are generated mirrors. The pool uses depth mode: large storage capacity, ranked retrieval, and conservative automatic maintenance.

Maintenance includes semantic merge, exact dedupe, lifecycle audit, LLM review, backups, and health checks. Destructive LLM suggestions are converted to disabled pending memories instead of hard deletes.

## Cockpit

`web/server.js` serves a local-only HTTP UI on `127.0.0.1`. `web/index.html` is a single-file cockpit for viewing, searching, editing, enabling, disabling, and reviewing memories.

The public command `hcm` opens the cockpit. `hcm-core` remains available for diagnostics and integrations.
