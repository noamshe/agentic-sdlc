# Extending the Terraform permission checker

## Purpose and trigger

Follow this procedure whenever a user provides unsupported Terraform resource or data-source items from a failed GitHub Actions permission check. Treat that list as the starting point for investigation; the user should not need to supply IAM action mappings or repeat this procedure.

Read `AI/global-rules.md` and follow its principles. Extend the repository's existing checker without modifying AWS, granting permissions, or bypassing the failing check. A denied permission is a finding to report, not something to repair by changing an IAM policy.

## Architecture

```text
Terraform plan
  → extract changed resource/data-source types and operations
  → deterministic Terraform-to-AWS-action mapping
  → AWS iam:SimulatePrincipalPolicy against the configured deployment role
  → allowed/denied or unable to verify
  → PASS only when everything can be verified
```

Include existing resources that require read/refresh permissions, even when their planned operation is no-op. An explicitly supported local/provider-only item can be verified as requiring no AWS actions; do not send an empty action list to IAM simulation.

The checker is a pre-deployment guardrail. It is not a replacement for AWS IAM authorization during `terraform apply`. A simulation result does not guarantee deployment success or authorize deployment. Preserve and report simulator limitations, including resource policies, policy conditions, session restrictions, and changes after the check.

## Procedure

### 1. Inspect the failure and its actual inputs

- Identify each unsupported type, its provider, whether it is a managed resource or data source, and its Terraform address. Use the actual failure logs to distinguish an unsupported mapping from a denied action or checker authentication/read-access failure.
- Inspect the relevant `infra/` configuration, referenced modules, provider versions, backend configuration, and dependency lockfile when present.
- Inspect the actual configuration and Terraform plan that caused the failure. Check the planned actions, before/after values, unknown and sensitive values, dependencies, provider settings, and replacement ordering. Do not infer operations from a type name alone.
- Locate available plan inputs and logs independently using authorized read-only access. If the failed plan was deleted, state that limitation. A synthetic test fixture is not evidence of what the failed run planned. If a replacement read-only plan is necessary, use the existing workflow/backend and only authorized read-only credentials, with locking disabled and no state writes. Never run apply. Do not execute untrusted provider/data-source code outside the read-only boundary.
- If the exact plan or essential configuration cannot be obtained, make only changes supported by available evidence, report the gap, and keep affected cases unverified. Request only the missing information needed to finish confidently.
- Never expose credentials, sensitive plan/state values, or raw secret-bearing artifacts in logs, comments, summaries, or committed fixtures.

### 2. Extend the existing implementation

Inspect these files before editing:

- `scripts/check-terraform-permissions.mjs`: extraction, mapping, simulation, and reporting.
- `tests/terraform-permissions.test.mjs`: existing fixtures and safety expectations.
- `.github/workflows/terraform-permission-check.yml`: runtime inputs and read-only workflow behavior.
- `docs/terraform-permission-check.md`: supported scope and documented limitations.

Add support to the existing mapping and extraction paths. Do not create a second checker, a parallel authorization mechanism, or a separate workflow to bypass unsupported items. Change workflow wiring only when necessary for the existing mechanism. Keep changes scoped to checker support, its tests, and relevant documentation; do not alter infrastructure requirements or the AI reviewer to obtain a pass.

### 3. Research actual IAM requirements

Use authoritative sources in this order:

1. Official HashiCorp Terraform AWS Provider documentation for the relevant resource/data source and provider version.
2. Official AWS Service Authorization Reference to verify exact IAM action names, resource types, dependent actions, and applicable condition keys.
3. Terraform AWS Provider implementation/source for the relevant version when documentation does not establish which API calls Terraform makes, including refreshes, waiters, and conditional branches.

For a non-AWS provider such as `hashicorp/archive`, consult that provider's official documentation/source to determine its behavior. Do not assume every data source is local: AWS data sources generally need read permissions, and external/provider-only sources can have effects that require investigation.

Never invent AWS IAM actions. An SDK/API operation name is not necessarily its IAM action name. Verify the mapping, including delete operations authorized by a put/configuration action. Do not use broad service wildcards to hide uncertainty. Record authoritative source links and relevant version assumptions in mapping documentation or comments.

Determine actions that the actual configuration and planned operation require, including indirect/dependent permissions. Examples include `iam:PassRole` on the specific role supplied to a service and applicable KMS or tagging permissions. Verify their resource scope and conditions; do not grant these permissions or merely assume they are included in the primary action.

### 4. Make deterministic, operation-aware mappings

For every newly supported type, define the applicable cases explicitly:

| Planned operation | Mapping requirement |
| --- | --- |
| Create | Creation actions, required post-create reads/waiters, and relevant dependent actions. |
| Update | Only update actions required by the changed attributes, plus necessary reads/dependencies. Do not automatically require create or delete actions. |
| Delete | Deletion actions and required reads/waiters. Do not automatically require create/update actions. |
| Read/refresh or no-op | Actual read/refresh actions; no mutation actions solely because the resource exists. |
| Replacement | Applicable create and delete actions with correct old/new resource scopes and ordering. |
| AWS data-source read | Read actions required to resolve that data source. |
| Local/provider-only item | Explicit support with an empty AWS action mapping, but only when research establishes that no AWS authorization is required. |

Support `archive_file` as requiring no AWS IAM actions when its inspected use only packages local files. Do not assign AWS permissions merely because it appears in the plan. Ensure provider/configuration validation also accepts the supported local provider so that an empty mapping is not rejected elsewhere.

Derive action/resource pairs from the real plan and configuration. Preserve concrete ARN scoping, required condition context, account/region checks, backend checks, and existing safety restrictions. If resource identifiers, dependencies, conditions, or required actions cannot be determined confidently, report the case as unverified and fail. Do not fabricate names, use arbitrary sample ARNs, assume missing context, or replace specific scopes with `*` to obtain an allow. Some AWS actions legitimately require `Resource: "*"`; use that only when the Service Authorization Reference establishes it and document why.

The runtime must remain deterministic. Do not introduce LLM calls, external inference APIs, or heuristics that guess authorization requirements. Authoritative research happens while developing mappings, not during each runtime check.

### 5. Preserve simulation and fail-closed decisions

Continue using AWS `iam:SimulatePrincipalPolicy` against the configured deployment role for AWS action/resource pairs that need verification. Do not substitute the checker role as the policy source, assume the deployer role, inject additional allow policies, or execute mutating AWS operations to test access.

Preserve these outcomes:

- Supported resource/data source and all required actions allowed: verified.
- Explicitly supported item requiring no AWS authorization: verified with no AWS actions, with that classification shown in reporting.
- Required action denied: FAIL, clearly identifying the action and resource.
- Unsupported resource/data source: FAIL.
- Inability to determine required permissions confidently: FAIL.
- Missing context, missing/incomplete simulation results, simulation/API errors, or an existing safety restriction: FAIL with the reason clearly reported.

PASS only when all relevant items and required permissions can be verified. Preserve pagination, permission-boundary/Organizations handling, and protections against unsupported resource policies. Never weaken an existing mapping, skip reads/dependencies, suppress an error, or treat unknown input as authorized merely to make a failing PR pass.

### 6. Test each new mapping

Add or update automated tests for every newly supported type. Cover each supported operation and the relevant configuration-dependent branches, not just one successful example. Include:

- Exact IAM action names, resource scopes, and dependent permissions.
- Create/update/delete/read separation, no-op refreshes, and replacements where applicable.
- Explicit zero-AWS-permission cases such as local `archive_file`, including provider validation/extraction and absence of IAM simulation calls for those items.
- Denied actions, unsupported variants, unknown values, missing dependencies/context, and incomplete results remaining failures.
- Compatibility with existing mappings and summary output, including visibility of items requiring no AWS permissions.

Use synthetic sanitized plans and mocked AWS responses for local tests. Never use apply or live mutation calls as a test. After implementation, run the relevant tests locally and run the existing suite when shared extraction, simulation, or reporting changes could affect it. The current repository command is `npm test`. Report actual results and any checks that could not run; do not claim live AWS verification from mocked tests.

### 7. Report before committing or pushing

Before any commit or push, provide a concrete implementation report containing:

- Terraform resource/data-source types and providers added to support.
- AWS IAM actions mapped for each operation, including read/refresh and resource scopes.
- Items explicitly classified as requiring no AWS IAM permissions.
- Indirect/dependent permissions, including relevant role/KMS/tagging conditions.
- Remaining unsupported variants, uncertainty, provider-version assumptions, and simulator limitations.
- Local test commands and results, including skipped/unavailable checks.
- Files changed and whether the original failed plan was available for inspection.

Do not commit or push unless explicitly requested. Existing explicit authorization in the session remains valid; do not request it again unnecessarily, but still deliver this report before the authorized commit/push. Otherwise leave the changes local for review. Do not merge or deploy without separate authorization.

## Non-negotiable safety boundaries

- Never create, modify, attach, detach, or delete AWS IAM roles or policies as part of extending the checker, including through Terraform configuration. Identify missing permissions; never grant them.
- Never change the GitHub deployer/checker roles or their trust policies to work around a failure.
- Never run `terraform apply` during this procedure, including for testing, debugging, or dependency discovery.
- Never make AWS resource mutations as part of determining permissions. Preserve the checker's read-only execution boundary and backend/state configuration.
- Never introduce secrets into source, fixtures, logs, prompts, or summaries.
- Never weaken fail-closed behavior or existing checker safety to make a PR pass.
