# Lab Lambda call chain

`GET /hello` invokes `agentic-sdlc-lab-hello`. It logs
`Hello from the Agentic SDLC lab.` and synchronously invokes
`new-inner-lambda-test`, which logs `hello from new lambda`.
Each greeting appears in its function's own CloudWatch log group. The outer
function decodes the inner response and returns HTTP 200 with
`Content-Type: text/plain; charset=utf-8` and these two lines:

```text
Hello from the Agentic SDLC lab.
hello from new lambda
```

The outer function fails if invocation is denied, times out, or the inner function
reports an error or returns an invalid/missing greeting, rather than returning
a successful greeting for a failed chain.
It uses the AWS SDK v3 included in the Node.js Lambda runtime and execution-role
credentials. This minimal lab package does not pin/bundle the SDK version.

Both functions use Node.js 24, ARM64 and 128 MB memory. The outer timeout is ten
seconds; the inner timeout is three seconds. Both log groups retain logs for one
day. Each execution role can write only to its own log group; only the outer
role may invoke the specific inner function. The inner function has no public
endpoint and no permission to invoke the outer function.

The outer entry point `hello/index.mjs` exports the router in `hello/routes.mjs`.
Its explicit `GET /hello` mapping calls `hello/handlers/hello.mjs`; unknown
method/path pairs return 404. API Gateway still exposes `GET /hello` explicitly
in Terraform. The inner Lambda also exports its router from `index.mjs`:
`new-inner-lambda-test/routes.mjs` maps the internal action `hello` to
`handlers/hello.mjs`. The outer Lambda sends `{ "action": "hello" }` in its
synchronous invocation. Unsupported actions fail; this router exposes no
public HTTP endpoint.

Application entry points are `hello/index.mjs` and
`new-inner-lambda-test/index.mjs`. Terraform definitions remain in
`infra/lambda.tf` and `infra/inner-lambda.tf`, with routing in `infra/api.tf`.
Terraform packages each application directory into an ignored ZIP under
`build/lambdas/`. Each function uses `index.handler` and the archive's
`output_base64sha256` as `source_code_hash`, so changed code triggers an update.
Both Terraform workflows watch `src/lambdas/**` as well as `infra/**`.
No AWS resources are deployed by local tests or validation.
