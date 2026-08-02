# Repository delivery policy

- Treat a development slice as complete only after its scoped changes are verified, committed, pushed, submitted as a pull request, and merged.
- Wait for required CI checks before merging. If checks fail, diagnose and fix them within the slice, then rerun verification and update the pull request.
- Prefer a squash merge when the repository allows it; otherwise use an allowed merge strategy.
- Do not stop at local changes or an open pull request unless the user explicitly asks not to publish or merge, or an external permission/protection rule blocks completion.
- Preserve unrelated working-tree changes and include only the intended slice in its commit and pull request.

## Database migration tracking

- Treat `docs/migration-status.md` as the source of truth for the highest migration verified on the current Supabase DB.
- Before adding or applying a migration, read that ledger and use only the next unapplied number; never rerun an applied migration on an existing DB.
- A merged migration or passing local/CI SQL test is not proof of deployment. Mark a migration applied only after the target DB is checked.
- After a verified DB application, update the ledger in the same delivery with the file, target, KST date, verification evidence, and next migration number, then tell the user exactly what is applied and what remains.
