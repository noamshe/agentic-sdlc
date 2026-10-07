# Extending the Terraform permission checker

This is an incremental agentic-SDLC lab. Prefer a small, correct extension completed quickly. Add support for the next unsupported type when it appears; do not solve future resource types or every theoretical configuration variant upfront.

## Fast path by default

Treat the unsupported resource/data-source types or failure output supplied by the user as the task scope and starting input.

- Do not reconstruct the failed GitHub Actions run or retrieve GitHub logs unless the user explicitly asks.
- Do not regenerate a Terraform plan unless the supplied information and relevant configuration are insufficient to understand the resource. Any necessary plan must use read-only credentials, no state writes, and locking disabled.
- A failed-run plan is not a prerequisite for a straightforward mapping extension. Ask only for information that is genuinely needed; leave unresolved cases unverified.

## Inspect minimum files

Start only with:

1. `scripts/check-terraform-permissions.mjs`
2. `tests/terraform-permissions.test.mjs`
3. The Terraform file defining the unsupported resource/data source.

Inspect additional files only when directly necessary, such as a referenced dependency needed to determine an ARN. Do not inspect the whole repository, workflow history, backend configuration, or unrelated Terraform resources for each extension. Preserve existing repository safety principles.

## Research only the required mapping

For each reported type, identify the Terraform operations and configuration being supported, then determine the AWS APIs and exact IAM actions the provider needs.

- Use official HashiCorp Terraform AWS Provider documentation/source and official AWS IAM documentation, including the Service Authorization Reference, as necessary. Consult the relevant provider version/source when actual calls are unclear.
- Verify IAM action names, resource scopes, conditions, and relevant dependent permissions such as `iam:PassRole`, tagging, or KMS. Never invent IAM actions or assume an SDK operation name is its IAM action name.
- For local/provider-only data sources, consult that provider's official documentation/source. Explicitly map local `archive_file` packaging to no AWS actions when applicable; do not assign AWS permissions merely because a data source appears in a plan.
- Record concise authoritative source links in mapping comments or directly relevant documentation.
- Stop researching once the deterministic mapping can be implemented confidently. Do not perform broad architectural research or investigate hypothetical variants unrelated to the current configuration.

## Extend incrementally

Extend the existing mapping for only the currently unsupported types. Keep this architecture:

```text
Terraform plan
-> resource/data-source types and operations
-> deterministic Terraform-to-AWS-action mapping
-> iam:SimulatePrincipalPolicy against the configured deployment role
-> allowed / denied / unverified
-> PASS only when everything is verified
```

Do not create another checker, generically implement an entire AWS service, or introduce LLM calls, runtime research, external inference APIs, or permission-guessing heuristics. Do not alter infrastructure requirements or workflows to bypass a failing check.

Preserve practical operation-aware mappings for the supported configuration:

- Create: creation actions, necessary post-create reads/waiters, and dependencies.
- Read/refresh or no-op: required reads, without unrelated mutation actions.
- Update: actions required by changed attributes and relevant dependencies.
- Delete: deletion actions and necessary reads/waiters.
- Replacement: applicable create/delete actions on the correct new/old resources.

Do not automatically require create, update, and delete permissions for a plan performing only one operation. Keep concrete resource scopes and required context. Do not fabricate identifiers, assume missing context, or broaden scopes to obtain a pass. Use `Resource: "*"` only for actions that legitimately require it.

Unknown or genuinely unsupported configuration variants may remain fail-closed. No exhaustive investigation of future variants is required.

## Keep fail-closed and read-only

- Supported item with every required action allowed: verified.
- Explicitly supported local item requiring no AWS authorization: verified with no AWS action simulation; identify it in the summary.
- Denied action, unknown resource, unsupported variant, unresolved identifier/permission, missing context, incomplete result, or API error: FAIL/unverified.

Preserve existing simulator safeguards, pagination, boundary/Organizations handling, resource-policy restrictions, and other checker safety checks. Never suppress failures, skip required permissions, weaken mappings, or silently authorize unknown cases to make a PR pass.

The checker must remain read-only and continue using `iam:SimulatePrincipalPolicy` against the configured deployment role. Never assume that role or inject allow policies to bypass verification. It is a pre-deployment guardrail, not a replacement for AWS IAM authorization during deployment.

Safety boundaries:

- Never run `terraform apply`.
- Never create, modify, or delete AWS resources.
- Never modify AWS IAM roles, policies, attachments, or trust policies, including the checker/deployer roles.
- Never grant missing permissions automatically; report them instead.
- Never expose secrets or sensitive plan/state values in source, fixtures, logs, or reports.
- Preserve the deterministic runtime and fail-closed behavior.

## Focused tests, once

Add focused automated tests for each new mapping: supported operations, exact actions/scopes, relevant dependencies, and unsupported/unknown cases staying failures. Cover zero-AWS-action behavior for local items when added.

Use sanitized synthetic plans and mocked AWS responses; tests must not mutate AWS.

1. Run the relevant checker tests: `node --test tests/terraform-permissions.test.mjs` (or a directly relevant subset).
2. Run the full `npm test` suite only if shared checker logic changed or focused tests fail.
3. Do not rerun passing tests without a reason, such as a subsequent code change or unresolved failure.

Do not claim live AWS verification from mocked tests.

## Short report and handoff

After implementation, report only:

- Resource/data-source types added.
- IAM actions mapped, including relevant dependencies or items requiring no AWS permissions.
- Files changed.
- Tests run and results.
- Anything that remains unsupported or unverified.

Keep the report concise. Do not commit or push unless explicitly requested for the work. Do not merge or deploy without separate authorization. Complete the small extension, then handle later unsupported types in a later iteration.
