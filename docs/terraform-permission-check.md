# Terraform permission check

`.github/workflows/terraform-permission-check.yml` is an independent PR check for changes under `infra/**` targeting `main`. It does not depend on or change AI review or deployment. Its concurrency group is separate, so all checks can run in parallel. Fork PRs are skipped rather than receiving AWS/state access.

The workflow uses GitHub OIDC to assume `github-terraform-plan-checker` in account `240742387601`, in `eu-west-1`. It initializes the existing S3 backend from `infra/versions.tf`, checks formatting, validates, and saves a refreshed plan locally. `plan -lock=false` avoids state lock writes; it never applies or persists refreshed state. The default workspace is used, matching the current deployment. No state or plan artifacts are uploaded, and temporary plan files are removed.

## How the check works

`scripts/check-terraform-permissions.mjs` consumes `terraform show -json` and Terraform's initialized backend metadata. It does not read or print state contents, raw plans, policies, or credentials. It derives action/resource pairs for the lab's four general-purpose S3 resource types:

| Terraform resource | Mutation actions simulated (never executed) |
| --- | --- |
| `aws_s3_bucket` | `s3:CreateBucket`, `s3:DeleteBucket`, `s3:PutBucketTagging` when tags change |
| `aws_s3_bucket_public_access_block` | `s3:PutBucketPublicAccessBlock` for writes and removal |
| `aws_s3_bucket_ownership_controls` | `s3:PutBucketOwnershipControls`, `s3:DeleteBucketOwnershipControls` |
| `aws_s3_bucket_server_side_encryption_configuration` | `s3:PutEncryptionConfiguration` for writes and removal |

The mapper also includes provider refresh/waiter reads for existing, unchanged, and newly created resources. Replacements check both the old and new bucket ARNs. Backend permissions include listing the state bucket, reading state, and the deployer's state writes; S3 lockfile actions are included if the existing backend enables them. These writes are only simulated, not granted or attempted.

For each concrete action/resource pair, the helper calls `iam:SimulatePrincipalPolicy` with the deployment role as `PolicySourceArn`. It supplies the deployment region and principal ARN, and the create-bucket location constraint. It handles pagination and rejects implicit/explicit denies, missing results, missing context, and denies reported by permission boundaries or Organizations. The checker never assumes the deployer role. Results and unverified actions are printed and written to the GitHub Step Summary. Any denial or incomplete verification fails the job.

This is a conservative, explicit mapping, not a general Terraform-to-IAM inference engine. Unsupported types, data sources, provider settings, inline bucket configuration, forced object deletion, KMS encryption, non-default workspaces, imports/moves, unknown tags, and unresolved bucket names fail verification. Existing `bucket_prefix` names are known from state; creating/replacing such a bucket will fail until its eventual ARN can be determined. No generated name or wildcard ARN is fabricated to obtain a pass. No infrastructure configuration is changed to work around this.

## External prerequisites (not configured by this change)

The checker role must trust this repository's PR OIDC subject (`repo:noamshe/agentic-sdlc:pull_request`) with audience `sts.amazonaws.com`. Restrict access to trusted contributors; Terraform/provider code from the PR runs with this identity and can read sensitive state. GitHub permissions are only `id-token: write` and `contents: read`.

The AWS role must already permit:

- Read-only refresh operations for the planned S3 resources and read/list access to the existing state backend.
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
