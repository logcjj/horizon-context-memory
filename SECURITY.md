# Security Policy

Horizon Context Memory is local-first and stores memory data on the user's machine. Please report security issues privately instead of opening a public issue.

## Sensitive data

HCM attempts to block or redact sensitive-looking values during capture, but memory content should still be treated as private local data. Do not publish `data/`, event logs, audit logs, SQLite databases, backups, or generated memory mirrors from a personal installation.

## Reporting

If you find a vulnerability, open a minimal private report with:

- affected version or commit
- reproduction steps
- expected impact
- suggested fix, if known
