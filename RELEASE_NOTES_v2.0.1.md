# Omni-Campus v2.0.1 Release Notes
Date: 2026-04-10
Release Type: Patch

## Summary
v2.0.1 is a housekeeping patch focused on repository hygiene for smoother collaboration and cleaner CI workflows.

## What Changed
- Added backend runtime artifact ignore rules in [.gitignore](.gitignore):
  - backend/data/*.db
  - backend/data/*.db-shm
  - backend/data/*.db-wal
  - backend/data/audit-log.jsonl

## Why This Matters
- Prevents accidental commits of local runtime database files.
- Keeps pull requests cleaner and easier to review.
- Reduces noisy git status output during development.

## Compatibility
- No API changes.
- No database schema changes.
- No frontend or backend runtime behavior changes.

## Upgrade Notes
- Pull latest main.
- Existing local runtime files remain on disk and continue to work.
- New runtime artifacts under backend/data are now ignored automatically.

## Previous Major Release
- v2.0.0 introduced recognition hardening, observability/security services, and presentation assets.

## Commits Included
- 325f37a - chore: ignore backend runtime data artifacts
