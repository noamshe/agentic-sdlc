# Lab Lambda call chain

`GET /hello` invokes `agentic-sdlc-lab-hello`. It logs
`Hello from the Agentic SDLC lab.` and synchronously invokes
`new-inner-lambda-test`, which logs `hello from new lambda`.
Each greeting appears in its function's own CloudWatch log group. The HTTP
response remains `{ "message": "Hello from the Agentic SDLC lab." }`.

The outer function fails if invocation is denied, times out, or the inner function
reports an error, rather than returning a successful greeting for a failed chain.
It uses the AWS SDK v3 included in the Node.js Lambda runtime and execution-role
credentials. This minimal lab package does not pin/bundle the SDK version.

Both functions use Node.js 24, ARM64 and 128 MB memory. The outer timeout is ten
seconds; the inner timeout is three seconds. Both log groups retain logs for one
day. Each execution role can write only to its own log group; only the outer
role may invoke the specific inner function. The inner function has no public
endpoint and no permission to invoke the outer function.

Terraform packages each source file into a generated, Git-ignored ZIP. The
deployer/checker roles, permission checker, and GitHub workflows are unchanged.
No AWS resources are deployed by local tests or validation.
