# Repository delivery policy

- Treat a development slice as complete only after its scoped changes are verified, committed, pushed, submitted as a pull request, and merged.
- Wait for required CI checks before merging. If checks fail, diagnose and fix them within the slice, then rerun verification and update the pull request.
- Prefer a squash merge when the repository allows it; otherwise use an allowed merge strategy.
- Do not stop at local changes or an open pull request unless the user explicitly asks not to publish or merge, or an external permission/protection rule blocks completion.
- Preserve unrelated working-tree changes and include only the intended slice in its commit and pull request.
