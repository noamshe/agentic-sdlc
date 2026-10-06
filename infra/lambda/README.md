# Minimal lab Lambda

`index.mjs` returns a fixed greeting. The archive provider packages it during Terraform planning; `function.zip` is generated locally and excluded from Git.

`../lambda.tf` defines a Node.js 24 ARM64 function with 128 MB memory and a three-second timeout, a dedicated execution role, and a log group retaining logs for one day. Its execution policy only allows creating streams and writing events in that log group. There is no API Gateway, public function URL, event source, scheduled invocation, VPC, or provisioned concurrency.

This change is intended to exercise the existing permission check without changing the GitHub deployer/checker roles. The current checker supports only S3 and fails on unmapped Lambda, IAM, CloudWatch, and archive resources; it cannot currently identify their missing deployment actions. A future deployment would require the deployer to have the appropriate Lambda, IAM (including PassRole), and logging permissions. This PR does not grant them or authorize deployment.
