let client;

export const createHandler = invokeInner => async () => {
  const message = 'Hello from the Agentic SDLC lab.';
  console.log(message);
  const result = await invokeInner({
    FunctionName: 'new-inner-lambda-test',
    InvocationType: 'RequestResponse',
    Payload: Buffer.from('{}')
  });
  // A synchronous invocation can return HTTP 200 even when the function failed.
  if (result.StatusCode !== 200 || result.FunctionError)
    throw new Error('Inner Lambda invocation failed');
  return { message };
};

export const handler = createHandler(async request => {
  // Node.js Lambda runtimes include AWS SDK v3; keep the lab ZIP minimal.
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  client ??= new LambdaClient({ maxAttempts: 1 });
  return client.send(new InvokeCommand(request), { abortSignal: AbortSignal.timeout(6000) });
});
