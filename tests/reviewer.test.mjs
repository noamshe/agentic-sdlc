import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedLines, inlineLocations, validateFindings, buildReview, redact, httpError, formatError, reviewSubmissionDiagnostics, main } from '../dist/index.js';

const lines = changedLines([{ filename: 'app.ts', patch: '@@ -10,2 +10,2 @@\n-old\n+new\n context', additions: 1, deletions: 1 }]);
const finding = { severity: 'HIGH', title: 'Failure', body: 'Concrete consequence and fix.', path: 'app.ts', line: 10, side: 'RIGHT' };

test('only actual additions and deletions can receive inline comments', () => {
  assert.equal(validateFindings({ findings: [finding] }, lines).length, 1);
  assert.equal(validateFindings({ findings: [{ ...finding, side: 'LEFT' }] }, lines).length, 1);
  for (const change of [{ line: 11 }, { path: 'other.ts' }, { side: 'wrong' }, { line: '10' }])
    assert.throws(() => validateFindings({ findings: [{ ...finding, ...change }] }, lines));
});

test('explicit inline locations use old/new file numbers across shifted hunks and omit context lines', () => {
  const changed = changedLines([{ filename: 'infra/api.tf', additions: 3, deletions: 3,
    patch: '@@ -10,4 +20,4 @@\n context\n-old1\n-old2\n+new1\n+new2\n end\n@@ -40 +60 @@\n-old3\n+new3' }]);
  const locations = inlineLocations(changed, []);
  assert.deepEqual(locations, [
    { path: 'infra/api.tf', line: 11, side: 'LEFT' }, { path: 'infra/api.tf', line: 12, side: 'LEFT' },
    { path: 'infra/api.tf', line: 21, side: 'RIGHT' }, { path: 'infra/api.tf', line: 22, side: 'RIGHT' },
    { path: 'infra/api.tf', line: 40, side: 'LEFT' }, { path: 'infra/api.tf', line: 60, side: 'RIGHT' }
  ]);
  for (const location of locations) assert.equal(validateFindings({ findings: [{ ...finding, ...location }] }, changed).length, 1);
  for (const location of [{ path: 'infra/api.tf', line: 20, side: 'RIGHT' }, { path: 'infra/api.tf', line: 21, side: 'LEFT' }])
    assert.throws(() => validateFindings({ findings: [{ ...finding, ...location }] }, changed), /inline location does not match/);
});

test('inline location input omits secret-bearing paths and summary findings retain blocking severity', () => {
  const changed = new Set([JSON.stringify(['private-value/app.ts', 1, 'RIGHT']), JSON.stringify(['sk-example-secret.ts', 1, 'RIGHT'])]);
  assert.deepEqual(inlineLocations(changed, ['private-value']), []);
  const findings = validateFindings({ findings: [{ ...finding, path: null, line: null, side: null }] }, changed);
  const review = buildReview(findings);
  assert.equal(review.event, 'REQUEST_CHANGES');
  assert.equal(review.comments.length, 0);
  assert.match(review.body, /Concrete consequence and fix/);
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

test('GitHub 422 diagnostics expose known nested validation rules and safe field/code labels', async () => {
  const error = await httpError('GitHub review submission', Response.json({ message: 'Unprocessable Entity', errors: [
    { resource: 'PullRequestReviewComment', field: 'line', code: 'invalid', value: 'private submitted value' },
    { resource: 'PullRequestReview', code: 'custom', message: 'Review comments is invalid' },
    'Pull request review thread line must be part of the diff',
    "Pull request review thread diff hunk can't be blank"
  ] }, { status: 422 }));
  const diagnostic = formatError(error, []);
  assert.match(diagnostic, /GitHub review submission HTTP 422/);
  assert.match(diagnostic, /errors\[0\]: resource: PullRequestReviewComment, field: line, code: invalid/);
  assert.match(diagnostic, /inline review comments or threads are invalid/);
  assert.match(diagnostic, /inline line must be part of the diff/);
  assert.match(diagnostic, /inline diff hunk cannot be blank/);
  assert.ok(!diagnostic.includes('private submitted value'));
});

test('GitHub nested diagnostics omit unknown messages, values, labels and secret-bearing content', async () => {
  const sensitive = 'private prompt text sk-example-secret ghp_exampletoken';
  const error = await httpError('GitHub', Response.json({ message: 'Validation Failed', errors: [
    { resource: sensitive, field: sensitive, code: sensitive, message: sensitive, value: sensitive },
    sensitive, { message: `Review comments is invalid: ${sensitive}` }, null,
    { field: 'body', code: 'missing_field' }, { message: sensitive }
  ], request: sensitive }, { status: 422 }));
  const diagnostic = formatError(error, []); // Safe even with no known-secret list.
  for (const text of [sensitive, 'private prompt text', 'sk-example-secret', 'ghp_exampletoken']) assert.ok(!diagnostic.includes(text));
  assert.match(diagnostic, /unrecognized \(withheld\)/);
  assert.match(diagnostic, /custom validation message withheld/);
  assert.match(diagnostic, /field: body, code: missing_field/);
  assert.match(diagnostic, /additional validation errors omitted/);
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

test('submission diagnostics identify each comment and only copy safe location fields', () => {
  const payload = { event: 'REQUEST_CHANGES', body: 'private review body', commit_id: 'not logged', comments: [
    { path: 'infra/api.tf', line: 28, side: 'RIGHT', body: 'private comment body' },
    { path: 'old.ts', line: 15, side: 'LEFT', start_line: 12, start_side: 'LEFT', body: 'private model output' }
  ] };
  const original = JSON.stringify(payload);
  assert.deepEqual(JSON.parse(reviewSubmissionDiagnostics(payload, [])), {
    event: 'REQUEST_CHANGES', comment_count: 2, comments: [
      { index: 0, path: 'infra/api.tf', line: 28, side: 'RIGHT', start_line: 'not submitted', start_side: 'not submitted' },
      { index: 1, path: 'old.ts', line: 15, side: 'LEFT', start_line: 12, start_side: 'LEFT' }
    ]
  });
  assert.equal(JSON.stringify(payload), original);
  assert.deepEqual(JSON.parse(reviewSubmissionDiagnostics({ event: 'APPROVE', comments: [] }, [])),
    { event: 'APPROVE', comment_count: 0, comments: [] });
});

test('submission diagnostics redact paths and withhold invalid metadata and echoed response content', async () => {
  const secret = 'private/value"withquote';
  const sensitive = 'private prompt and model output';
  const payload = { event: sensitive, body: sensitive, comments: [
    { path: `${secret}/${encodeURIComponent(secret)}/ghp_exampletoken/sk-example-secret\nfile.ts`,
      line: sensitive, side: sensitive, start_line: -1, start_side: sensitive, body: sensitive }
  ] };
  const diagnostic = reviewSubmissionDiagnostics(payload, [secret]);
  for (const value of [secret, encodeURIComponent(secret), 'ghp_exampletoken', 'sk-example-secret', sensitive])
    assert.ok(!diagnostic.includes(value));
  assert.ok(!diagnostic.includes('\n'));
  const error = await httpError('GitHub review submission', Response.json({ message: sensitive, code: sensitive, type: sensitive,
    errors: [{ field: 'comments[0].line', code: 'invalid', message: sensitive, value: sensitive },
      { message: 'PullRequestReview threads is invalid' }] }, { status: 422 }), payload);
  const logged = formatError(error, [secret]);
  assert.match(logged, /field: comments\[0\]\.line, code: invalid/);
  assert.match(logged, /inline review comments or threads are invalid/);
  assert.match(logged, /zero-based comment indexes/);
  assert.ok(!logged.includes(sensitive));
  const bounded = JSON.parse(reviewSubmissionDiagnostics({ event: 'COMMENT', comments: Array.from({ length: 6 }, () =>
    ({ path: 'x'.repeat(5000), line: 1, side: 'RIGHT' })) }, []));
  assert.equal(bounded.comments.length, 5);
  assert.equal(bounded.comment_count, 6);
  assert.equal(bounded.comments[0].path.length, 200);
  assert.equal(bounded.additional_comments, 'omitted');
});

test('validation diagnostics identify schema fields, item indexes and violated rules', () => {
  const without = field => Object.fromEntries(Object.entries(finding).filter(([key]) => key !== field));
  for (const [value, expected] of [
    [null, 'response: expected an object'],
    [{}, 'response: missing required field findings'],
    [{ findings: [], extra: true }, 'response: unexpected fields'],
    [{ findings: {} }, 'findings: expected an array'],
    [{ findings: Array(21).fill(finding) }, 'findings: exceeds maximum of 20 items'],
    [{ findings: [null] }, 'findings[0]: expected an object'],
    [{ findings: [without('body')] }, 'findings[0]: missing required fields: body'],
    [{ findings: [{ ...finding, extra: true }] }, 'findings[0]: unexpected fields'],
    [{ findings: [{ ...finding, severity: 'INVALID' }] }, 'findings[0].severity: expected BLOCKER, HIGH, MEDIUM or LOW'],
    [{ findings: [{ ...finding, title: 123 }] }, 'findings[0].title: expected a string'],
    [{ findings: [{ ...finding, body: '   ' }] }, 'findings[0].body: must not be blank'],
    [{ findings: [{ ...finding, title: 'x'.repeat(201) }] }, 'findings[0].title: exceeds maximum of 200 characters'],
    [{ findings: [{ ...finding, body: '\u0001' }] }, 'findings[0].body: contains forbidden control characters'],
    [{ findings: [{ ...finding, path: null }] }, 'findings[0]: path, line and side must all be null or form a complete inline location'],
    [{ findings: [{ ...finding, path: 123 }] }, 'findings[0].path: expected a string for an inline location'],
    [{ findings: [{ ...finding, line: '10' }] }, 'findings[0].line: expected a positive safe integer'],
    [{ findings: [{ ...finding, side: 'WRONG' }] }, 'findings[0].side: expected LEFT or RIGHT'],
    [{ findings: [{ ...finding, line: 11 }] }, 'findings[0]: inline location does not match a changed line in the PR diff'],
    [{ findings: [finding, finding] }, 'findings[1]: duplicate finding']
  ]) {
    assert.throws(() => validateFindings(value, lines), error => {
      assert.equal(formatError(error, []), `Invalid review findings: ${expected}`);
      return true;
    });
  }
});

test('validation diagnostics never echo untrusted values, field names or sensitive content', () => {
  const sensitive = 'private prompt content with sk-example-secret and ghp_exampletoken';
  for (const value of [
    { findings: [], [sensitive]: sensitive },
    { findings: [{ ...finding, [sensitive]: sensitive }] },
    { findings: [{ ...finding, severity: sensitive }] },
    { findings: [{ ...finding, title: sensitive + '\u0001' }] },
    { findings: [{ ...finding, body: sensitive.repeat(100) }] },
    { findings: [{ ...finding, path: sensitive }] },
    { findings: [{ ...finding, line: sensitive }] },
    { findings: [{ ...finding, side: sensitive }] }
  ]) {
    assert.throws(() => validateFindings(value, lines), error => {
      const diagnostic = formatError(error, []); // Safe even without known-secret redaction.
      for (const text of [sensitive, 'private prompt content', 'sk-example-secret', 'ghp_exampletoken'])
        assert.ok(!diagnostic.includes(text));
      assert.ok(!Object.hasOwn(error, 'cause'));
      assert.match(diagnostic, /^Invalid review findings:/);
      return true;
    });
  }
});

test('invalid findings and GitHub validation rejections fail closed without approval fallbacks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'review-validation-'));
  const eventPath = join(directory, 'event.json');
  const pr = { number: 1, state: 'open', draft: false, changed_files: 1, title: 'private PR title', body: 'private prompt content',
    head: { sha: 'head-sha', ref: 'feature', repo: { full_name: 'owner/repo' } }, base: { sha: 'base-sha', ref: 'main' } };
  const env = { GITHUB_TOKEN: 'ghp_testgithubsecret', OPENAI_API_KEY: 'sk-testopenaisecret', GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'owner/repo' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let githubWrites = 0;
  let modelFinding = { ...finding, severity: 'private prompt content' };
  let rejectReview = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://api.openai.com/')) {
      const request = JSON.parse(options.body);
      const input = JSON.parse(request.input[0].content);
      assert.deepEqual(input.validInlineLocations, [{ path: 'app.ts', line: 10, side: 'LEFT' }, { path: 'app.ts', line: 10, side: 'RIGHT' }]);
      assert.match(request.instructions, /validInlineLocations/);
      assert.ok(!options.body.includes(env.GITHUB_TOKEN));
      assert.ok(!options.body.includes(env.OPENAI_API_KEY));
      return Response.json({ status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ findings: [modelFinding] }) }] }] });
    }
    if (options.method !== 'GET') {
      githubWrites++;
      if (!rejectReview) throw new Error('Unexpected GitHub write');
      assert.ok(String(url).endsWith('/reviews'));
      const review = JSON.parse(options.body);
      assert.deepEqual(review, { commit_id: pr.head.sha, ...buildReview([finding]) });
      assert.equal(review.commit_id, pr.head.sha);
      assert.equal(review.event, 'REQUEST_CHANGES');
      assert.equal(review.comments[0].line, 10);
      assert.equal(review.comments[0].side, 'RIGHT');
      return Response.json({ message: 'Unprocessable Entity', errors: [
        { resource: 'PullRequestReview', code: 'custom', message: 'Review comments is invalid' }
      ] }, { status: 422 });
    }
    if (String(url).includes('/files?')) return Response.json([{ filename: 'app.ts',
      patch: '@@ -10,2 +10,2 @@\n-old\n+new\n context', additions: 1, deletions: 1 }]);
    if (options.headers.Accept.includes('diff')) return new Response('PR diff');
    return Response.json(pr);
  });
  try {
    await writeFile(eventPath, JSON.stringify({ pull_request: pr }));
    Object.assign(process.env, env);
    await assert.rejects(main(), error => {
      const diagnostic = formatError(error);
      assert.match(diagnostic, /findings\[0\]\.severity: expected BLOCKER, HIGH, MEDIUM or LOW/);
      for (const text of [env.GITHUB_TOKEN, env.OPENAI_API_KEY, pr.title, pr.body]) assert.ok(!diagnostic.includes(text));
      return true;
    });
    modelFinding = { ...finding, line: 11 };
    await assert.rejects(main(), /inline location does not match a changed line in the PR diff/);
    assert.equal(githubWrites, 0);
    modelFinding = finding;
    rejectReview = true;
    await assert.rejects(main(), error => {
      const diagnostic = formatError(error);
      assert.match(diagnostic, /GitHub review submission HTTP 422.*inline review comments or threads are invalid/);
      assert.match(diagnostic, /"event":"REQUEST_CHANGES"/);
      assert.match(diagnostic, /"index":0,"path":"app.ts","line":10,"side":"RIGHT","start_line":"not submitted","start_side":"not submitted"/);
      for (const text of [finding.title, finding.body, pr.title, pr.body, env.GITHUB_TOKEN, env.OPENAI_API_KEY])
        assert.ok(!diagnostic.includes(text));
      return true;
    });
    assert.equal(githubWrites, 1); // No retries, summary-only fallback, or clean approval.
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
