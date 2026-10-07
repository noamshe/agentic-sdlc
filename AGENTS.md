# Agent Development Instructions

## Repository structure

- `src/` - application code
- `src/lambdas/<lambda-name>/` - Lambda application code
- `infra/` - Terraform infrastructure
- `tests/` - automated tests
- `AI/` - AI reviewer/checker instructions
- `.github/workflows/` - CI/CD and PR checks

Keep application code separate from infrastructure code.

## Development workflow

For every new feature or bug fix:

1. Always start from the latest `main`.
2. Never develop directly on `main`.
3. Create a new descriptive branch from `main`.
4. Implement the requested change on that branch.
5. Run the relevant tests and validation.
6. Push the branch.
7. Create a Pull Request targeting `main`.
8. Do not merge the Pull Request.
9. Do not deploy manually.
10. Stop and let the repository PR checks run.

The PR is the integration boundary.

All development methods must follow the same workflow:
- Codex Cloud
- Codex in VS Code
- Human developers
- Other coding agents

After the PR is created, the existing GitHub workflows are responsible
for AI review, infrastructure permission checks when applicable, and
deployment after merge.
