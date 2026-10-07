# Developing Lambdas

For a request such as "Add a new Lambda called orders", use:

```text
src/lambdas/orders/index.mjs
    -> data.archive_file (local ZIP)
    -> aws_lambda_function
    -> optional API Gateway integration/route
```

- Put application code and local helpers in `src/lambdas/<name>/`. Export
  `handler` from `index.mjs`; keep Terraform in `infra/<name>-lambda.tf`.
  Use `hello` as the directory convention for the existing outer Lambda;
  preserve existing Terraform addresses and AWS names when refactoring.
- For an HTTP Lambda, keep `index.mjs` as the entry point exporting the
  dispatcher from `routes.mjs`. Put endpoint logic in `handlers/<name>.mjs`
  and explicitly map method/path pairs such as `'GET /hello'` to handlers.
  The current router reads HTTP API payload v2 method and `rawPath`, forwards
  event/context, and returns 404 for unmatched requests. Keep the matching
  API Gateway route explicit in Terraform too; an application route alone
  does not expose an endpoint. For internal Lambdas, use the same
  `index.mjs -> routes.mjs -> handlers/<name>.mjs` structure but dispatch
  explicit actions from the invocation payload (e.g. `{ action: 'hello' }`).
  Reject unknown actions and forward event/context to the selected handler.
  Update callers and tests together; internal action routes require no
  public API Gateway endpoint.
- Package the directory with `archive_file.source_dir =
  "${path.module}/../src/lambdas/<name>"` and write `output_path` to
  `"${path.module}/../build/lambdas/<name>.zip"`. The archive provider creates
  the output directory. ZIPs are generated, ignored artifacts: never commit
  or maintain them manually, or place them in source directories.
- Set the function's `filename` to the archive's `output_path`,
  `source_code_hash` to its `output_base64sha256`, and `handler` to
  `"index.handler"`. Package changes then update deployed code without
  needing to publish numbered Lambda versions. Keep ZIPs available between
  plan and apply; the existing deployment does both in the same job.
- Follow the existing Node.js/ARM64 settings and small memory/timeouts.
  Keep dependencies required by the handler in its package; the current
  lab uses the runtime-provided AWS SDK v3. Keep tests outside packaged
  directories and run `npm test` after changes.
- Define a dedicated execution role trusting only `lambda.amazonaws.com`,
  a short-retention log group, and runtime permissions scoped to required
  resources. Use explicit dependencies on supporting execution policies.
  Lambda-to-Lambda invocation needs `lambda:InvokeFunction` on the target
  function ARN in the caller's role; do not grant it to the deployer.
- Add an endpoint only when requested. In `infra/api.tf`, keep an explicit
  `route_key = "GET /orders"` (or requested method/path), target its named
  HTTP API Lambda proxy integration, and add `aws_lambda_permission` for
  `apigateway.amazonaws.com` scoped to the API, stage, method, and route.
- Both Terraform workflows watch `infra/**` and `src/lambdas/**`; preserve
  those filters so application-only changes receive permission checks and
  deployment after merging to main. Extend the deterministic checker only
  when needed, following `AI/checker-instructions.md`.
- Run Terraform formatting/validation when available and relevant tests.
  Never run apply or change AWS manually during development. Never modify
  deployer/checker IAM to bypass missing permissions. Production deployment
  requires human approval; commit/push only when requested.
