import test from 'node:test';
import assert from 'node:assert/strict';
import { changedLines, validateFindings, buildReview, redact, httpError, formatError } from '../dist/index.js';

const lines = changedLines([{ filename: 'app.ts', patch: '@@ -10,2 +10,2 @@\n-old\n+new\n context', additions: 1, deletions: 1 }]);
const finding = { severity: 'HIGH', title: 'Failure', body: 'Concrete consequence and fix.', path: 'app.ts', line: 10, side: 'RIGHT' };

test('only actual additions and deletions can receive inline comments', () => {
  assert.equal(validateFindings({ findings: [finding] }, lines).length, 1);
  assert.equal(validateFindings({ findings: [{ ...finding, side: 'LEFT' }] }, lines).length, 1);
  for (const change of [{ line: 11 }, { path: 'other.ts' }, { side: 'wrong' }, { line: '10' }])
    assert.throws(() => validateFindings({ findings: [{ ...finding, ...change }] }, lines));
});
test('untrusted schema, severity, duplicate and oversized output are rejected', () => {
  for (const value of [null, { findings: [], event: 'APPROVE' }, { findings: [{ ...finding, severity: 'CRITICAL' }] },
    { findings: [finding, finding] }, { findings: [{ ...finding, body: 'x'.repeat(2001) }] }, { findings: Array(21).fill(finding) }])
    assert.throws(() => validateFindings(value, lines));
});
test('review decision and inline limit are controlled by runtime', () => {
  assert.equal(buildReview([]).event, 'APPROVE');
  for (const severity of ['BLOCKER', 'HIGH']) assert.equal(buildReview([{ ...finding, severity }]).event, 'REQUEST_CHANGES');
  for (const severity of ['MEDIUM', 'LOW']) assert.equal(buildReview([{ ...finding, severity }]).event, 'COMMENT');
  const review = buildReview(Array.from({ length: 8 }, (_, n) => ({ ...finding, title: `Issue ${n}` })));
  assert.equal(review.comments.length, 5);
  assert.match(review.body, /Issue 7/);
  assert.equal(buildReview([{ ...finding, path: null, line: null, side: null }]).comments.length, 0);
});
test('missing and truncated patches never produce clean approval', () => {
  assert.throws(() => changedLines([{ filename: 'binary', additions: 0, deletions: 0 }]));
  assert.throws(() => changedLines([{ filename: 'app', patch: '@@ -1 +1 @@\n+a', additions: 2, deletions: 0 }]));
});
test('credentials are redacted and comment text cannot mention users or inject HTML', () => {
  assert.equal(redact('credential abc123', ['abc123']), 'credential [REDACTED]');
  assert.equal(redact('token = supersecret\nnext', []), 'token = [REDACTED]\nnext');
  assert.equal(redact('ghp_abcdef', []), '[REDACTED]');
  const review = buildReview([{ ...finding, body: '@admin <script> [click](https://example.org)' }]);
  assert.ok(!review.body.includes('@admin'));
  assert.ok(!review.body.includes('<script>'));
  assert.ok(!review.body.includes('[click](https://example.org)'));
});

test('HTTP diagnostics retain status, provider code and message but exclude raw response data', async () => {
  const error = await httpError('LLM', new Response(JSON.stringify({
    error: { message: 'Model unavailable', code: 'model_not_found', type: 'invalid_request_error' },
    request: 'private request content'
  }), { status: 404, statusText: 'Not Found' }));
  const diagnostic = formatError(error, []);
  assert.match(diagnostic, /LLM HTTP 404 Not Found: Model unavailable/);
  assert.match(diagnostic, /code: model_not_found/);
  assert.match(diagnostic, /type: invalid_request_error/);
  assert.ok(!diagnostic.includes('private request content'));
  const github = await httpError('GitHub', new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 }));
  assert.match(formatError(github, []), /HTTP 403.*Resource not accessible/);
  const nonJson = await httpError('GitHub', new Response('private proxy response', { status: 502 }));
  assert.match(formatError(nonJson, []), /HTTP 502/);
  assert.ok(!formatError(nonJson, []).includes('private proxy response'));
});

test('error messages, codes and causes are sanitized before logging', () => {
  const secret = 'private/value"withquote';
  const error = Object.assign(new Error(`failed ${secret}\n${encodeURIComponent(secret)}`), {
    code: secret, cause: Object.assign(new Error(JSON.stringify(secret)), { code: 'ECONNRESET' }),
    headers: { Authorization: 'never-print-headers' }
  });
  const diagnostic = formatError(error, [secret]);
  for (const value of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), 'never-print-headers'])
    assert.ok(!diagnostic.includes(value));
  assert.match(diagnostic, /ECONNRESET/);
  assert.ok(!diagnostic.includes('\n'));
  assert.ok(!formatError(new Error('Authorization: Bearer unexpectedcredential'), []).includes('unexpectedcredential'));
  assert.match(formatError(new Error('Invalid review findings'), []), /Invalid review findings/);
});
