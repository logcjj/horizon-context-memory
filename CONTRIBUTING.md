# Contributing

Thanks for considering a contribution to Horizon Context Memory.

## Development

Requirements:

- Node.js 20+
- macOS or Linux shell environment

Run checks:

```bash
npm run check
```

Run the local cockpit without opening a browser automatically:

```bash
bin/hcm --no-open
```

Use an isolated data directory while developing:

```bash
HCM_HOME=/tmp/hcm-dev bin/hcm --no-open
```

## Pull requests

Keep changes focused. For memory behavior changes, include the intent, affected lifecycle stage, and the validation command you ran.

Do not commit local memory data, event logs, SQLite files, backups, secrets, or personal Codex configuration.
