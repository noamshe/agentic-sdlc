import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/lambdas/login/index.mjs';

test('GET /login serves the packaged HTML with labelled inputs and credential-free demo navigation', async () => {
  const response = await handler({ rawPath: '/login', requestContext: { http: { method: 'GET' } } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-security-policy'], /default-src 'none'.*form-action 'none'/);
  assert.match(response.body, /<label for="username">Username<\/label>/);
  assert.match(response.body, /<label for="password">Password<\/label>/);
  assert.match(response.body, /<input id="password" type="password"/);
  assert.match(response.body, /<a class="sign-in" href="\/back-office"[^>]*>Sign in<\/a>/);
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

test('demo navigation opens the back office and returns to login without credentials', async () => {
  const get = path => handler({ rawPath: path, requestContext: { http: { method: 'GET' } } });
  const login = await get('/login');
  const destination = login.body.match(/class="sign-in" href="([^"]+)"/)[1];
  const office = await get(destination);
  assert.equal(office.statusCode, 200);
  assert.equal(office.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(office.headers['cache-control'], 'no-store');
  assert.match(office.body, /Welcome to your back office/);
  assert.match(office.body, /no account is needed/);
  assert.equal((office.body.match(/<svg[^>]+role="img"/g) ?? []).length, 3);
  assert.equal((office.body.match(/<title id=/g) ?? []).length, 3);
  const logout = office.body.match(/class="logout" href="([^"]+)"/)[1];
  assert.equal(logout, '/login');
  assert.equal((await get(logout)).body, login.body);
  assert.ok(!/<(?:form|script)\b/i.test(office.body));
  assert.ok(!/\b(?:src|href|action)\s*=\s*["']https?:/i.test(office.body));
  assert.equal((await handler({ rawPath: destination, requestContext: { http: { method: 'POST' } } })).statusCode, 404);
});
