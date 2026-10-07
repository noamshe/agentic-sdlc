import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/lambdas/login/index.mjs';

test('GET /login serves the packaged HTML with labelled inputs and a non-submitting button', async () => {
  const response = await handler({ rawPath: '/login', requestContext: { http: { method: 'GET' } } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-security-policy'], /default-src 'none'.*form-action 'none'/);
  assert.match(response.body, /<label for="username">Username<\/label>/);
  assert.match(response.body, /<label for="password">Password<\/label>/);
  assert.match(response.body, /<input id="password" type="password"/);
  assert.match(response.body, /<button type="button"[^>]*>Sign in<\/button>/);
  assert.ok(!/<(?:form|script)\b|\bonclick\s*=|\bonsubmit\s*=/i.test(response.body));
  assert.ok(!/\b(?:src|href|action)\s*=\s*["']https?:/i.test(response.body));
  assert.match(response.body, /Nothing you enter is submitted/);
});

test('login only dispatches its registered GET route and never renders request credentials', async () => {
  for (const event of [undefined, {}, { rawPath: '/missing', requestContext: { http: { method: 'GET' } } },
    { rawPath: '/login', requestContext: { http: { method: 'POST' } } }])
    assert.equal((await handler(event)).statusCode, 404);
  const response = await handler({ rawPath: '/login', requestContext: { http: { method: 'GET' } },
    queryStringParameters: { username: 'private-user-value', password: 'private-password-value' }, body: 'private-body-value' });
  for (const value of ['private-user-value', 'private-password-value', 'private-body-value']) assert.ok(!response.body.includes(value));
});
