# Terraform permission check

`.github/workflows/terraform-permission-check.yml` is an independent PR check for changes under `infra/**` or `src/lambdas/**` targeting `main`. It does not depend on AI review or deployment. Its concurrency group is separate, so all checks can run in parallel. Fork PRs are skipped rather than receiving AWS/state access.

The workflow uses GitHub OIDC to assume `github-terraform-plan-checker` in account `240742387601`, in `eu-west-1`. It initializes the existing S3 backend from `infra/versions.tf`, checks formatting, validates, and saves a refreshed plan locally. `plan -lock=false` avoids state lock writes; it never applies or persists refreshed state. The default workspace is used, matching the current deployment. No state or plan artifacts are uploaded, and temporary plan files are removed.

## How the check works

`scripts/check-terraform-permissions.mjs` consumes `terraform show -json`, Terraform's initialized backend metadata, and root-module `.tf` files for the direct role references described below. It does not print state contents, raw plans, policies, or credentials. It derives action/resource pairs using the existing deterministic mapping:

| Terraform resource | Mutation actions simulated (never executed) |
| --- | --- |
| `aws_s3_bucket` | `s3:CreateBucket`, `s3:DeleteBucket`, `s3:PutBucketTagging` when tags change |
| `aws_s3_bucket_public_access_block` | `s3:PutBucketPublicAccessBlock` for writes and removal |
| `aws_s3_bucket_ownership_controls` | `s3:PutBucketOwnershipControls`, `s3:DeleteBucketOwnershipControls` |
| `aws_s3_bucket_server_side_encryption_configuration` | `s3:PutEncryptionConfiguration` for writes and removal |

### Lambda and execution-role support

These additions were checked against the AWS provider **v6.67.0** used by the failed Lambda run. The workflow's AWS 6.x constraint is unchanged. Every supported operation includes the refresh/waiter actions in the next table; create, update and delete actions are added only when planned. Replacements verify old and new identities separately.

| Terraform type | Create | Update, only when the relevant field changes | Delete |
| --- | --- | --- | --- |
| `aws_cloudwatch_log_group` | `logs:CreateLogGroup`; `logs:PutRetentionPolicy` for positive retention | `logs:PutRetentionPolicy` for positive retention or `logs:DeleteRetentionPolicy` to remove it | `logs:DeleteLogGroup`, unless `skip_destroy` |
| `aws_iam_role` | `iam:CreateRole` | `iam:UpdateAssumeRolePolicy`, `iam:UpdateRoleDescription`, `iam:UpdateRole` for trust, description, or session duration respectively | `iam:DeleteRole`; `iam:ListInstanceProfilesForRole`; `iam:DeleteRolePolicy` for existing inline policies; `iam:DetachRolePolicy` for known managed attachments |
| `aws_iam_role_policy` | `iam:PutRolePolicy` | `iam:PutRolePolicy` | `iam:DeleteRolePolicy` |
| `aws_lambda_function` | `lambda:CreateFunction`; `iam:PassRole` | `lambda:UpdateFunctionCode` for code/hash/architecture; `lambda:UpdateFunctionConfiguration` for role, runtime, handler, memory, timeout, description, or logging configuration; `iam:PassRole` only when the role changes | `lambda:DeleteFunction`, unless `skip_destroy` |
| `data.archive_file` (`hashicorp/archive`) | Not applicable | Local ZIP packaging/read only; **no AWS IAM actions** | Not applicable |

| Terraform type | Read/refresh and waiter permissions | Resource scope |
| --- | --- | --- |
| `aws_cloudwatch_log_group` | `logs:DescribeLogGroups`, `logs:ListTagsForResource` | Describe requires `*` according to AWS's authorization reference. Tag reads/writes use `arn:aws:logs:eu-west-1:240742387601:log-group:NAME`; create, retention and delete use that ARN with `:*`. |
| `aws_iam_role` | `iam:GetRole`, `iam:ListRolePolicies`, `iam:GetRolePolicy`, `iam:ListAttachedRolePolicies` | Concrete role ARN including its known path. Policy reads cover the provider's inline-policy refresh loop. |
| `aws_iam_role_policy` | `iam:GetRolePolicy` | The concrete parent role ARN, not an invented inline-policy ARN. |
| `aws_lambda_function` | `lambda:GetFunction`, `lambda:ListTags`, `lambda:ListVersionsByFunction`, `lambda:GetFunctionCodeSigningConfig` | Unqualified `arn:aws:lambda:eu-west-1:240742387601:function:NAME` for the supported ZIP configuration. |
| `data.archive_file` | None | Explicitly supported local `type`, `source_file` or `source_dir`, and `output_path` configuration, even when already resolved and absent from `resource_changes`. Shown separately in the summary; no IAM simulation for the archive. |

Tag additions/changes require `iam:TagRole`, `logs:TagResource`, or `lambda:TagResource`; removals require the corresponding `UntagRole`/`UntagResource`. Unknown configured tags fail. Computed `tags_all` on an untagged create does not represent a tagging request when the provider has no default tags (provider settings beyond the region remain unsupported).

`iam:PassRole` is simulated on the actual Lambda execution-role ARN with `iam:PassedToService=lambda.amazonaws.com`. Detaching known managed policies supplies `iam:PolicyARN` per attachment. Actions **inside** `aws_iam_role_policy.policy` are the function's runtime permissions, not deployment actions: granting log writes to the execution role requires `iam:PutRolePolicy`, not log writes by the deployer.

The plan can leave a new execution-role ARN and inline-policy role name unknown. The checker accepts those only when root HCL has an exact direct assignment (`role = aws_iam_role.NAME.arn` for Lambda, `.id`/`.name` for an inline policy), the plan references agree, and that role's planned name/path establish its exact ARN. References alone, string transformations, conditionals, modules/indexed instances with unresolved roles, unknown/generated names, cross-account roles and ambiguous dependencies fail. Existing known role ARNs are accepted; a known role name requires a uniquely matching planned role with a known path.

Support is intentionally restricted to the inspected local ZIP, unpublished, unqualified Lambda with basic logging/configuration, a basic execution role with a separately managed inline policy, and standard non-KMS log groups. Advanced Lambda configuration, role boundaries/policy attachments configured through `aws_iam_role`, forced detach, and other unmapped attributes fail. Before certifying a role deletion, the checker makes a read-only `ListInstanceProfilesForRole` call and fails if profiles exist or the response is incomplete; it never removes a role from a profile. Additional configurations need researched mappings and tests.

Evidence: the failed run's human-readable plan showed four creates (Lambda, role, inline policy and log group), AWS provider 6.67.0 and archive provider 2.8.1. Its original JSON plan was deleted and no artifact remained. Tests reconstruct sanitized cases from that log and the actual repository configuration; they are not a copy of the original plan or evidence of live AWS authorization.

The mapper also includes provider refresh/waiter reads for existing, unchanged, and newly created resources. Replacements check both the old and new bucket ARNs. Backend permissions include listing the state bucket, reading state, and the deployer's state writes; S3 lockfile actions are included if the existing backend enables them. These writes are only simulated, not granted or attempted.

For each concrete action/resource pair, the helper calls `iam:SimulatePrincipalPolicy` with the deployment role as `PolicySourceArn`. It supplies the deployment region and principal ARN, and the create-bucket location constraint. It handles pagination and rejects implicit/explicit denies, missing results, missing context, and denies reported by permission boundaries or Organizations. The checker never assumes the deployer role. Results and unverified actions are printed and written to the GitHub Step Summary. Any denial or incomplete verification fails the job.

This is a conservative, explicit mapping, not a general Terraform-to-IAM inference engine. Unsupported types, data sources, provider settings, inline bucket configuration, forced object deletion, KMS encryption, non-default workspaces, imports/moves, unknown tags, and unresolved bucket names fail verification. Existing `bucket_prefix` names are known from state; creating/replacing such a bucket will fail until its eventual ARN can be determined. No generated name or wildcard ARN is fabricated to obtain a pass. No infrastructure configuration is changed to work around this.

## API Gateway generated IDs

The checker supports the untagged API Gateway v2 HTTP API, Lambda proxy integration,
public route, stage, and unqualified `aws_lambda_permission` subset. Management
actions are `apigateway:POST` for creates, `apigateway:GET` for refreshes,
`apigateway:PATCH` for mapped updates, and `apigateway:DELETE` for deletes.
Lambda permissions use `lambda:GetPolicy`, `lambda:AddPermission`, and
`lambda:RemovePermission`, scoped to the function; mutations retain the
`lambda:Principal=apigateway.amazonaws.com` simulation context.

AWS-generated IDs marked unknown in a create plan are normal. API creation checks
`POST` on `arn:aws:apigateway:eu-west-1::/apis` and post-create `GET` on `/apis/*`.
For an integration, route, or stage with an unknown API ID, the checker requires
an exact root-module HCL assignment `api_id = aws_apigatewayv2_api.NAME.id`, matching
plan references, and that API's same-plan HTTP create/replacement with a computed
unknown ID. Child creates then check `POST` on `/apis/*/integrations`, `/routes`,
or `/stages`, and `GET` on the respective child paths. Integration/route IDs marked
unknown on create use `*` in their ID segment; a stage still needs its known name.
New children under an existing API retain that API's concrete ID.

These ARN patterns are explicit simulation scopes for generated identifiers, not
invented IDs or skipped permissions. All mapped action/scope pairs must be allowed
by `iam:SimulatePrincipalPolicy`; API collection creation alone is insufficient.
Missing context, missing results, denied actions, unsupported configuration,
unproven/transformed dependencies, and unknown existing/update/delete identities
still fail. Replacements use the old concrete scopes for deletes and generated
scopes only for new creates; no PATCH/DELETE is added solely for a create.

Pattern simulation is a preflight check, not universal proof for every eventual
ID: identifier-specific policies/denies or resource conditions can produce a
different authorization result during apply. No live AWS deployment was used to
validate this mapping. Sources: [AWS API Gateway v2 authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_apigatewayv2.html),
[IAM simulation API](https://docs.aws.amazon.com/IAM/latest/APIReference/API_SimulatePrincipalPolicy.html),
and [AWS provider v6.67.0 API implementation](https://github.com/hashicorp/terraform-provider-aws/blob/v6.67.0/internal/service/apigatewayv2/api.go).

## External prerequisites (not configured by this change)

The checker role must trust this repository's PR OIDC subject (`repo:noamshe/agentic-sdlc:pull_request`) with audience `sts.amazonaws.com`. Restrict access to trusted contributors; Terraform/provider code from the PR runs with this identity and can read sensitive state. GitHub permissions are only `id-token: write` and `contents: read`.

The AWS role must already permit:

- Read-only refresh operations for the planned S3 resources and read/list access to the existing state backend.
- The read/refresh actions above for existing Lambda, IAM and log resources. `logs:DescribeLogGroups` needs `Resource: "*"`; other reads use the relevant concrete resource ARNs.
- `iam:ListInstanceProfilesForRole` on execution roles when a role deletion is planned, for the read-only safety inspection.
- `iam:SimulatePrincipalPolicy`, scoped to `arn:aws:iam::240742387601:role/github-terraform-deployer`.
- `s3:GetBucketPolicy` on the relevant buckets and state bucket, to detect resource policies the role simulation cannot evaluate.
- `s3:GetEncryptionConfiguration` on the state bucket, to reject backend encryption requiring unmapped KMS permissions.

It must have **no AWS mutation permissions**, including no IAM policy/role mutation permissions and no backend state/lock write permissions. This workflow cannot enforce or configure an IAM role's actual policies; that restriction must exist in AWS before the check is enabled. It makes no IAM changes and never automatically grants missing actions. A checker permission error fails the check and is distinguished from missing deployer permissions.

## Limits of effective-permission validation

AWS IAM simulation evaluates attached identity policies and supported restrictive policy types, without invoking the simulated service operations. It does not guarantee live authorization. Resource policies cannot be simulated for IAM roles through this API; the helper reads bucket policies and refuses to certify any bucket with such a policy rather than silently ignoring it. Resource control policies, endpoint policies, deployment-session restrictions, provider changes within the AWS 6.x version range, and policies changing after the PR check can still affect deployment. Success explicitly means all **mapped pairs are allowed in simulation**, not that a future apply cannot fail. Extend and test the mapping when adding resource types or changing provider behavior. No read-only preflight can prove arbitrary future AWS calls will succeed.

Local tests use mocked IAM responses and synthetic plans; they make no AWS calls:

```sh
npm test
```

References: [Terraform JSON output](https://developer.hashicorp.com/terraform/internals/json-format), [AWS IAM simulation API](https://docs.aws.amazon.com/IAM/latest/APIReference/API_SimulatePrincipalPolicy.html), [AWS simulator limitations](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_testing-policies.html), [AWS provider S3 implementation](https://github.com/hashicorp/terraform-provider-aws/tree/main/internal/service/s3).

New mapping research, in priority order:

1. Official HashiCorp AWS provider documentation: [Lambda function](https://registry.terraform.io/providers/hashicorp/aws/6.67.0/docs/resources/lambda_function), [IAM role](https://registry.terraform.io/providers/hashicorp/aws/6.67.0/docs/resources/iam_role), [IAM role policy](https://registry.terraform.io/providers/hashicorp/aws/6.67.0/docs/resources/iam_role_policy), [CloudWatch log group](https://registry.terraform.io/providers/hashicorp/aws/6.67.0/docs/resources/cloudwatch_log_group); [archive_file](https://registry.terraform.io/providers/hashicorp/archive/2.8.1/docs/data-sources/file) documents local packaging.
2. Official AWS Service Authorization References: [Lambda](https://docs.aws.amazon.com/service-authorization/latest/reference/list_lambda.html), [IAM](https://docs.aws.amazon.com/service-authorization/latest/reference/list_iam.html), [CloudWatch Logs](https://docs.aws.amazon.com/service-authorization/latest/reference/list_logs.html).
3. Provider v6.67.0 implementations for actual refresh/waiter/update/delete branches: [Lambda](https://github.com/hashicorp/terraform-provider-aws/blob/v6.67.0/internal/service/lambda/function.go), [IAM role](https://github.com/hashicorp/terraform-provider-aws/blob/v6.67.0/internal/service/iam/role.go), [IAM inline policy](https://github.com/hashicorp/terraform-provider-aws/blob/v6.67.0/internal/service/iam/role_policy.go), [log group](https://github.com/hashicorp/terraform-provider-aws/blob/v6.67.0/internal/service/logs/group.go), and generated service tagging helpers in those directories.
