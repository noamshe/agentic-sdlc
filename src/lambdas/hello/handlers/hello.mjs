let client;

export const createHandler = invokeInner => async () => {
  const message = 'Hello from the Agentic SDLC lab.';
  console.log(message);
  const result = await invokeInner({
    FunctionName: 'new-inner-lambda-test',
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify({ action: 'hello' }))
  });
  // A synchronous invocation can return HTTP 200 even when the function failed.
  if (result.StatusCode !== 200 || result.FunctionError)
    throw new Error('Inner Lambda invocation failed');
  let inner;
  try {
    if (!(result.Payload instanceof Uint8Array)) throw new Error();
    inner = JSON.parse(Buffer.from(result.Payload).toString('utf8'));
  } catch {
    throw new Error('Inner Lambda returned an invalid response');
  }
  if (!inner || typeof inner.message !== 'string' || !inner.message.trim())
    throw new Error('Inner Lambda returned an invalid response');
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: `${message}\n${inner.message}`,
    isBase64Encoded: false
  };
};

export const handler = createHandler(async request => {
  // Node.js Lambda runtimes include AWS SDK v3; keep the lab ZIP minimal.
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  client ??= new LambdaClient({ maxAttempts: 1 });
  return client.send(new InvokeCommand(request), { abortSignal: AbortSignal.timeout(6000) });
});
