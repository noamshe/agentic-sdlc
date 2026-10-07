# Private S3 bucket

This configuration defines one uniquely named S3 bucket in `eu-west-1` (Ireland), with all four Block Public Access settings enabled, ACLs disabled through `BucketOwnerEnforced`, and default SSE-S3 (`AES256`) encryption.

There are no bucket objects, public policies, KMS keys, or replication. Storage and request charges depend on future usage. Credentials are obtained through the AWS provider's standard external credential chain; never commit credentials or Terraform state.

## Lambda applications

Application code lives under `src/lambdas/`; this directory contains Terraform
infrastructure only. `lambda.tf` packages `src/lambdas/hello/` and
`inner-lambda.tf` packages `src/lambdas/new-inner-lambda-test/`, writing ignored
ZIPs to `build/lambdas/`. Functions deploy those ZIPs with `index.handler` and
the archive SHA-256 as `source_code_hash`. Keep Terraform resource addresses
and AWS names stable when moving source files.

`api.tf` explicitly maps `GET /hello` to the outer Lambda, which invokes the
inner Lambda and returns both greetings. See [the application notes](../src/lambdas/README.md)
and [Lambda development instructions](../AI/lambda-development.md).

Local configuration checks, when Terraform is installed:

```sh
terraform -chdir=infra fmt -check
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
```

Initialization downloads the provider and creates a dependency lockfile; commit `.terraform.lock.hcl` when generated. Validation does not deploy resources. No deployment is authorized; production deployment requires explicit human approval.
