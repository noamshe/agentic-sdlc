import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const severities = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'] as const;
type Finding = { severity: typeof severities[number]; title: string; body: string;
  path: string | null; line: number | null; side: 'LEFT' | 'RIGHT' | null };
type FileDiff = { filename: string; patch?: string; additions: number; deletions: number };

// Providers return unknown data. Validation and review decisions remain outside the provider.
export interface LlmProvider { review(instructions: string, input: string): Promise<unknown> }
const schema = {
  type: 'object', additionalProperties: false, required: ['findings'], properties: {
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['severity', 'title', 'body', 'path', 'line', 'side'], properties: {
        severity: { type: 'string', enum: severities }, title: { type: 'string' },
        body: { type: 'string' }, path: { type: ['string', 'null'] },
        line: { type: ['integer', 'null'] }, side: { enum: ['LEFT', 'RIGHT', null] }
      }
    } }
  }
};

export class OpenAiProvider implements LlmProvider {
  constructor(private apiKey: string, private model: string) {}
  async review(instructions: string, input: string): Promise<unknown> {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, store: false, instructions,
        input: [{ role: 'user', content: input }], max_output_tokens: 6000,
        text: { format: { type: 'json_schema', name: 'pr_review', strict: true, schema } } })
    });
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
    const result = await response.json() as { status?: string; output?: {
      type: string; content?: { type: string; text?: string }[] }[] };
    if (result.status !== 'completed') throw new Error('LLM did not complete');
    const content = result.output?.filter(x => x.type === 'message').flatMap(x => x.content ?? []) ?? [];
    if (content.some(x => x.type === 'refusal')) throw new Error('LLM refused review');
    const output = content.filter(x => x.type === 'output_text').map(x => x.text ?? '').join('');
    if (output.length > 60_000) throw new Error('LLM output too large');
    try { return JSON.parse(output); } catch { throw new Error('LLM returned invalid JSON'); }
  }
}

export function changedLines(files: FileDiff[]): Set<string> {
  const lines = new Set<string>();
  for (const file of files) {
    let left = 0, right = 0, added = 0, removed = 0, inHunk = false;
    if (!file.patch) throw new Error('Missing file patch; refusing partial review');
    for (const line of file.patch.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) { left = Number(hunk[1]); right = Number(hunk[2]); inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('+')) { lines.add(JSON.stringify([file.filename, right++, 'RIGHT'])); added++; }
      else if (line.startsWith('-')) { lines.add(JSON.stringify([file.filename, left++, 'LEFT'])); removed++; }
      else if (line.startsWith(' ')) { left++; right++; }
    }
    if (added !== file.additions || removed !== file.deletions)
      throw new Error('Incomplete file patch; refusing partial review');
  }
  return lines;
}

export function validateFindings(value: unknown, lines: Set<string>): Finding[] {
  const bad = () => { throw new Error('Invalid review findings'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  const root = value as Record<string, unknown>;
  if (Object.keys(root).join() !== 'findings' || !Array.isArray(root.findings) || root.findings.length > 20) return bad();
  const seen = new Set<string>();
  for (const item of root.findings) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return bad();
    const f = item as Finding;
    if (Object.keys(f).sort().join() !== 'body,line,path,severity,side,title' || !severities.includes(f.severity)) return bad();
    for (const [text, max] of [[f.title, 200], [f.body, 2000]] as const)
      if (typeof text !== 'string' || !text.trim() || text.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return bad();
    const location = JSON.stringify([f.path, f.line, f.side]);
    if (!(f.path === null && f.line === null && f.side === null) &&
        !(typeof f.path === 'string' && Number.isSafeInteger(f.line) && (f.line ?? 0) > 0 &&
          (f.side === 'LEFT' || f.side === 'RIGHT') && lines.has(location))) return bad();
    const key = JSON.stringify(f);
    if (seen.has(key)) return bad();
    seen.add(key);
  }
  return (root.findings as Finding[]).sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity));
}

// Defense in depth for recognized credentials and every secret supplied to this process.
export function redact(text: string, secrets: string[]): string {
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]');
}
const plain = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/@/g, '@\u200b').replace(/[\\`*_{}\[\]()!#|]/g, '\\$&');

export function buildReview(findings: Finding[]) {
  const event = findings.some(f => f.severity === 'BLOCKER' || f.severity === 'HIGH')
    ? 'REQUEST_CHANGES' : findings.length ? 'COMMENT' : 'APPROVE';
  const format = (f: Finding) => `[${f.severity}] ${plain(f.title)}\n\n${plain(f.body)}`;
  const inline = findings.filter(f => f.path !== null).slice(0, 5);
  return { event, body: findings.length
    ? `AI code review\n\n${findings.map(f => `${format(f)}${f.path ? `\n\nLocation: ${plain(f.path)}:${f.line} (${f.side})` : ''}`).join('\n\n---\n\n')}`
    : 'AI code review: no actionable findings in the supplied PR diff.',
    comments: inline.map(f => ({ path: f.path!, line: f.line!, side: f.side!, body: format(f) })) };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export async function main() {
  const token = required('GITHUB_TOKEN'), apiKey = required('OPENAI_API_KEY');
  const secrets = Object.entries(process.env).filter(([key]) => /TOKEN|SECRET|PASSWORD|KEY/i.test(key))
    .map(([, value]) => value ?? '');
  const event = JSON.parse(await readFile(required('GITHUB_EVENT_PATH'), 'utf8'));
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') throw new Error('Expected pull_request event');
  const repo = required('GITHUB_REPOSITORY');
  const number = event.pull_request?.number;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid PR event');
  const base = `https://api.github.com/repos/${repo}/pulls/${number}`;
  async function github(url: string, method = 'GET', body?: unknown, accept = 'application/vnd.github+json') {
    const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: accept, 'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28' }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    return accept.includes('diff') ? response.text() : response.json();
  }
  const pr = await github(base);
  if (pr.state !== 'open' || pr.draft || pr.head.sha !== event.pull_request.head.sha ||
      pr.base.sha !== event.pull_request.base.sha) throw new Error('PR changed or is not reviewable');
  if (pr.head.repo?.full_name !== repo) throw new Error('Fork PRs cannot use repository secrets');
  if (pr.changed_files > 100) throw new Error('PR exceeds 100-file review limit');
  const [diff, files, globalRules, reviewerRules] = await Promise.all([
    github(base, 'GET', undefined, 'application/vnd.github.v3.diff'),
    github(`${base}/files?per_page=100`),
    readFile('AI/global-rules.md', 'utf8'), readFile('AI/reviewer.md', 'utf8')
  ]);
  if (!Array.isArray(files) || files.length !== pr.changed_files || typeof diff !== 'string' || !diff.trim())
    throw new Error('Missing or incomplete PR diff');
  const lines = changedLines(files);
  const instructions = redact(`${globalRules}\n\n${reviewerRules}`, secrets);
  const input = JSON.stringify({ metadata: { number, title: redact(pr.title, secrets), description: redact(pr.body ?? '', secrets),
    base: redact(pr.base.ref, secrets), head: redact(pr.head.ref, secrets), commit: pr.head.sha }, diff: redact(diff, secrets) });
  if (input.length + instructions.length > 150_000) throw new Error('PR exceeds input limit; no partial approval');
  const provider: LlmProvider = new OpenAiProvider(apiKey, process.env.OPENAI_MODEL || 'gpt-4.1');
  const output = await provider.review(instructions, input);
  // Redact output too; the model must never publish a credential copied from input.
  const findings = validateFindings(output, lines).map(f => ({ ...f,
    title: redact(f.title, secrets), body: redact(f.body, secrets) }));
  const current = await github(base);
  if (current.state !== 'open' || current.draft || current.head.sha !== pr.head.sha ||
      current.base.sha !== pr.base.sha || current.title !== pr.title || current.body !== pr.body)
    throw new Error('PR changed during review; retry on the current version');
  await github(`${base}/reviews`, 'POST', { commit_id: pr.head.sha, ...buildReview(findings) });
  console.log('AI review published.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Never log raw API responses, PR content, model output, or exception messages.
    console.error('AI review failed safely; no approval was issued by this run. Check credentials, PR limits, and API availability.');
    process.exitCode = 1;
  });
}
