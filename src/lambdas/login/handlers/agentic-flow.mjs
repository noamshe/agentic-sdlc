import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../agentic-flow.html', import.meta.url), 'utf8');

export const handler = async () => ({
  statusCode: 200,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
  },
  body: page,
  isBase64Encoded: false
});
