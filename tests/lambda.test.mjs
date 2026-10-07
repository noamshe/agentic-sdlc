import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/lambdas/hello/handlers/hello.mjs';
import { createRouter } from '../src/lambdas/hello/routes.mjs';
import { handler as entryPoint } from '../src/lambdas/hello/index.mjs';
import { handler as innerHandler } from '../src/lambdas/new-inner-lambda-test/index.mjs';
import { createRouter as createInnerRouter } from '../src/lambdas/new-inner-lambda-test/routes.mjs';

test('outer returns both greetings as plain-text HTTP lines and each Lambda logs its own greeting', async t => {
  const logs = [];
  t.mock.method(console, 'log', message => logs.push(message));
  let invocations = 0;
  const outer = createHandler(async request => {
    invocations++;
    assert.equal(request.FunctionName, 'new-inner-lambda-test');
    assert.equal(request.InvocationType, 'RequestResponse');
    const payload = JSON.parse(request.Payload.toString());
    assert.deepEqual(payload, { action: 'hello' });
    const inner = await innerHandler(payload);
    assert.deepEqual(inner, { message: 'hello from new lambda' });
    return { StatusCode: 200, Payload: new Uint8Array(Buffer.from(JSON.stringify(inner))) };
  });
  const router = createRouter({ 'GET /hello': outer });
  assert.deepEqual(await router({ rawPath: '/hello', requestContext: { http: { method: 'GET' } } }), {
    statusCode: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: 'Hello from the Agentic SDLC lab.\nhello from new lambda',
    isBase64Encoded: false
  });
  assert.equal(invocations, 1);
  assert.deepEqual(logs, ['Hello from the Agentic SDLC lab.', 'hello from new lambda']);
});

test('inner routes forward event/context and reject unsupported actions without echoing payloads', async () => {
  const event = { action: 'hello' };
  const context = { awsRequestId: 'inner-request' };
  const router = createInnerRouter({ hello: async (receivedEvent, receivedContext) => {
    assert.equal(receivedEvent, event);
    assert.equal(receivedContext, context);
    return { message: 'result' };
  } });
  assert.deepEqual(await router(event, context), { message: 'result' });
  for (const payload of [undefined, {}, { action: 'private payload' }, { action: '__proto__' }, { action: 123 }])
    await assert.rejects(innerHandler(payload), error => {
      assert.equal(error.message, 'Unknown inner Lambda action');
      return true;
    });
  await assert.rejects(createInnerRouter({ hello: async () => { throw new Error('Handler failed'); } })(event), /Handler failed/);
});

test('router forwards the event and context to the selected handler and propagates failures', async () => {
  const event = { rawPath: '/hello', requestContext: { http: { method: 'GET' } }, rawQueryString: 'example=1' };
  const context = { awsRequestId: 'test-request' };
  const router = createRouter({ 'GET /hello': async (receivedEvent, receivedContext) => {
    assert.equal(receivedEvent, event);
    assert.equal(receivedContext, context);
    return { statusCode: 200, body: 'result' };
  } });
  assert.deepEqual(await router(event, context), { statusCode: 200, body: 'result' });
  await assert.rejects(createRouter({ 'GET /hello': async () => { throw new Error('Invocation failed'); } })(event), /Invocation failed/);
});

test('entry point rejects unknown paths, wrong methods and malformed HTTP events without invoking Lambda', async () => {
  for (const event of [undefined, {}, { rawPath: '/hello' },
    { rawPath: '/missing', requestContext: { http: { method: 'GET' } } },
    { rawPath: '/hello', requestContext: { http: { method: 'POST' } } }]) {
    assert.deepEqual(await entryPoint(event), {
      statusCode: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not found', isBase64Encoded: false
    });
  }
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
