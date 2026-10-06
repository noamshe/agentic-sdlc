# Private S3 bucket

This configuration defines one uniquely named S3 bucket in `eu-west-1` (Ireland), with all four Block Public Access settings enabled, ACLs disabled through `BucketOwnerEnforced`, and default SSE-S3 (`AES256`) encryption.

There are no bucket objects, public policies, KMS keys, replication, or other infrastructure. Storage and request charges depend on future usage. Credentials are obtained through the AWS provider's standard external credential chain; never commit credentials or Terraform state.

Local configuration checks, when Terraform is installed:

```sh
terraform -chdir=infra fmt -check
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
```

Initialization downloads the provider and creates a dependency lockfile; commit `.terraform.lock.hcl` when generated. Validation does not deploy resources. No deployment is authorized; production deployment requires explicit human approval.
