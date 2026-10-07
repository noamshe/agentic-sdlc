import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../infra/lambda/index.mjs';
import { handler as innerHandler } from '../infra/inner-lambda/index.mjs';

test('outer returns both greetings as plain-text HTTP lines and each Lambda logs its own greeting', async t => {
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
    return { StatusCode: 200, Payload: new Uint8Array(Buffer.from(JSON.stringify(inner))) };
  });
  assert.deepEqual(await outer(), {
    statusCode: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: 'Hello from the Agentic SDLC lab.\nhello from new lambda',
    isBase64Encoded: false
  });
  assert.equal(invocations, 1);
  assert.deepEqual(logs, ['Hello from the Agentic SDLC lab.', 'hello from new lambda']);
});

test('outer rejects malformed or missing inner greetings without exposing response contents', async t => {
  t.mock.method(console, 'log', () => {});
  const sensitive = 'private response content';
  for (const Payload of [undefined, Buffer.from(sensitive), ...[null, {}, { message: 123 }, { message: '  ' }]
    .map(value => Buffer.from(JSON.stringify(value)))]) {
    await assert.rejects(createHandler(async () => ({ StatusCode: 200, Payload }))(), error => {
      assert.equal(error.message, 'Inner Lambda returned an invalid response');
      assert.ok(!error.message.includes(sensitive));
      return true;
    });
  }
});

test('outer propagates invocation failures and rejects inner errors even with HTTP 200', async t => {
  t.mock.method(console, 'log', () => {});
  await assert.rejects(createHandler(async () => { throw new Error('AccessDeniedException'); })(), /AccessDeniedException/);
  await assert.rejects(createHandler(async () => { throw new Error('TimeoutError'); })(), /TimeoutError/);
  for (const response of [{ StatusCode: 200, FunctionError: 'Unhandled' }, { StatusCode: 202 }])
    await assert.rejects(createHandler(async () => response)(), /Inner Lambda invocation failed/);
});
