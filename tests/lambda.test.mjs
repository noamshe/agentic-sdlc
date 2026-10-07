import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../infra/lambda/index.mjs';
import { handler as innerHandler } from '../infra/inner-lambda/index.mjs';

test('outer invokes inner synchronously and each Lambda logs its own greeting', async t => {
  const logs = [];
  t.mock.method(console, 'log', message => logs.push(message));
  let invocations = 0;
  const outer = createHandler(async request => {
    invocations++;
    assert.equal(request.FunctionName, 'new-inner-lambda-test');
    assert.equal(request.InvocationType, 'RequestResponse');
    assert.deepEqual(JSON.parse(request.Payload.toString()), {});
    const inner = await innerHandler();
    assert.deepEqual(inner, { message: 'hello from new lambda' });
    return { StatusCode: 200, Payload: Buffer.from(JSON.stringify(inner)) };
  });
  assert.deepEqual(await outer(), { message: 'Hello from the Agentic SDLC lab.' });
  assert.equal(invocations, 1);
  assert.deepEqual(logs, ['Hello from the Agentic SDLC lab.', 'hello from new lambda']);
});

test('outer propagates invocation failures and rejects inner errors even with HTTP 200', async t => {
  t.mock.method(console, 'log', () => {});
  await assert.rejects(createHandler(async () => { throw new Error('AccessDeniedException'); })(), /AccessDeniedException/);
  await assert.rejects(createHandler(async () => { throw new Error('TimeoutError'); })(), /TimeoutError/);
  for (const response of [{ StatusCode: 200, FunctionError: 'Unhandled' }, { StatusCode: 202 }])
    await assert.rejects(createHandler(async () => response)(), /Inner Lambda invocation failed/);
});
