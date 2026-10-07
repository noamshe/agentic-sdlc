import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requiredPermissions, directRoleBindings, simulate, report, failureAnnotations, s3Buckets, verifyRoleProfiles } from '../scripts/check-terraform-permissions.mjs';

const provider = 'registry.terraform.io/hashicorp/aws';
const backend = { backend: { type: 's3', config: {
  bucket: 'lab-state', key: 'lab/terraform.tfstate', region: 'eu-west-1'
} } };
function resource(type, actions, before, after) {
  return { address: `${type}.example`, type, mode: 'managed', provider_name: provider,
    change: { actions, before, after, after_unknown: {} } };
}
function plan(resources) {
  return { format_version: '1.2', complete: true, resource_changes: resources,
    configuration: { provider_config: { aws: { full_name: provider,
      expressions: { region: { constant_value: 'eu-west-1' } } } },
    root_module: { resources: resources.map(r => ({ ...r, expressions: { bucket: {} } })) } } };
}

test('maps real IAM names and backend permissions without executing mutations', () => {
  const result = requiredPermissions(plan([
    resource('aws_s3_bucket', ['create'], null, { bucket: 'lab-created' }),
    resource('aws_s3_bucket_public_access_block', ['update'], { bucket: 'lab-created' }, { bucket: 'lab-created' }),
    resource('aws_s3_bucket_server_side_encryption_configuration', ['delete'], { bucket: 'lab-created' }, null),
    resource('aws_s3_bucket_ownership_controls', ['delete'], { bucket: 'lab-created' }, null)
  ]), backend);
  assert.deepEqual(result.issues, []);
  const actions = new Set(result.requirements.map(r => r.action));
  for (const action of ['s3:CreateBucket', 's3:PutBucketPublicAccessBlock', 's3:GetBucketPublicAccessBlock',
    's3:PutEncryptionConfiguration', 's3:DeleteBucketOwnershipControls', 's3:GetBucketCORS',
    's3:GetReplicationConfiguration', 's3:GetAccelerateConfiguration', 's3:PutObject'])
    assert.ok(actions.has(action), action);
  assert.ok(result.requirements.some(r => r.action === 's3:PutObject' && r.resource === 'arn:aws:s3:::lab-state/lab/terraform.tfstate'));
  assert.ok(!actions.has('s3:DeleteBucketPublicAccessBlock'));
  assert.ok(!actions.has('s3:DeleteBucketEncryption'));
});

test('no-op resources still need refresh reads but no mutation actions', () => {
  const { requirements } = requiredPermissions(plan([
    resource('aws_s3_bucket', ['no-op'], { bucket: 'lab-bucket' }, { bucket: 'lab-bucket' })
  ]), backend);
  assert.ok(requirements.some(r => r.action === 's3:ListBucket'));
  assert.ok(!requirements.some(r => r.action === 's3:CreateBucket' || r.action === 's3:DeleteBucket'));
});

test('replacement simulates delete on the old ARN and create on the new ARN', () => {
  const { requirements } = requiredPermissions(plan([
    resource('aws_s3_bucket', ['delete', 'create'], { bucket: 'lab-old' }, { bucket: 'lab-new' })
  ]), backend);
  assert.ok(requirements.some(r => r.action === 's3:DeleteBucket' && r.resource === 'arn:aws:s3:::lab-old'));
  assert.ok(requirements.some(r => r.action === 's3:CreateBucket' && r.resource === 'arn:aws:s3:::lab-new'));
  assert.ok(!requirements.some(r => r.action === 's3:DeleteBucket' && r.resource === 'arn:aws:s3:::lab-new'));
});

test('tag updates do not require CreateBucket and tagging targets only the planned bucket', () => {
  const { requirements } = requiredPermissions(plan([
    resource('aws_s3_bucket', ['update'], { bucket: 'lab-bucket', tags_all: {} },
      { bucket: 'lab-bucket', tags_all: { purpose: 'lab' } })
  ]), backend);
  assert.ok(requirements.some(r => r.action === 's3:PutBucketTagging'));
  assert.ok(!requirements.some(r => r.action === 's3:CreateBucket'));
});

test('unknown names, unsupported resources and incomplete plans fail closed', () => {
  for (const change of [resource('aws_s3_bucket', ['create'], null, { bucket_prefix: 'lab-' }),
    resource('aws_lambda_function', ['create'], null, {}),
    resource('aws_s3_bucket', ['create'], null, { bucket: 'lab-bucket', force_destroy: true })]) {
    const result = requiredPermissions(plan([change]), backend);
    assert.ok(result.issues.length);
    assert.match(report([], result.issues), /FAIL/);
    assert.ok(!result.requirements.some(r => r.resource === '*'));
  }
  const incomplete = plan([]); incomplete.complete = false;
  assert.ok(requiredPermissions(incomplete, backend).issues.length);
});

test('unsupported configuration and backend locking are handled explicitly', () => {
  const config = plan([resource('aws_s3_bucket', ['update'], { bucket: 'lab-bucket' }, { bucket: 'lab-bucket' })]);
  config.configuration.root_module.resources[0].expressions.policy = {};
  assert.ok(requiredPermissions(config, backend).issues.some(issue => issue.includes('.policy')));
  const locking = structuredClone(backend); locking.backend.config.use_lockfile = true;
  const { requirements } = requiredPermissions(plan([]), locking);
  assert.ok(requirements.some(r => r.action === 's3:DeleteObject' && r.resource.endsWith('.tflock')));
  locking.backend.config.dynamodb_table = 'locks';
  assert.ok(requiredPermissions(plan([]), locking).issues.length);
});

test('simulates the deployer role with concrete ARNs and reports missing permissions', async () => {
  const requirements = [{ action: 's3:CreateBucket', resource: 'arn:aws:s3:::lab-new' },
    { action: 's3:PutBucketPublicAccessBlock', resource: 'arn:aws:s3:::lab-new' }];
  const results = await simulate(requirements, async (service, operation, request) => {
    assert.equal(service, 'iam'); assert.equal(operation, 'simulate-principal-policy');
    assert.equal(request.PolicySourceArn, 'arn:aws:iam::240742387601:role/github-terraform-deployer');
    assert.deepEqual(request.ResourceArns, ['arn:aws:s3:::lab-new']);
    assert.ok(!request.PolicyInputList);
    return { EvaluationResults: [{ EvalActionName: request.ActionNames[0], EvalResourceName: request.ResourceArns[0],
      EvalDecision: request.ActionNames[0] === 's3:CreateBucket' ? 'allowed' : 'implicitDeny' }] };
  });
  assert.equal(results[0].allowed, true); assert.equal(results[1].allowed, false);
  assert.match(report(results, []), /Missing or unverified actions: s3:PutBucketPublicAccessBlock/);
  assert.match(report(results, []), /FAIL/);
  assert.match(report([results[0]], []), /PASS/);
});

test('missing context, boundaries, SCP denial and absent results cannot pass', async () => {
  const requirement = { action: 's3:ListBucket', resource: 'arn:aws:s3:::lab-bucket' };
  for (const detail of [{ MissingContextValues: ['aws:SourceIp'] },
    { PermissionsBoundaryDecisionDetail: { AllowedByPermissionsBoundary: false } },
    { OrganizationsDecisionDetail: { AllowedByOrganizations: false } },
    { ResourceSpecificResults: [{ EvalResourceDecision: 'explicitDeny' }] }]) {
    const results = await simulate([requirement], async () => ({ EvaluationResults: [{
      EvalActionName: requirement.action, EvalResourceName: requirement.resource, EvalDecision: 'allowed', ...detail
    }] }));
    assert.equal(results[0].allowed, false);
  }
  assert.equal((await simulate([requirement], async () => ({ EvaluationResults: [] })))[0].allowed, false);
});

test('simulation pagination is read completely and invalid truncation fails', async () => {
  const requirement = { action: 's3:ListBucket', resource: 'arn:aws:s3:::lab-bucket' };
  let calls = 0;
  const results = await simulate([requirement], async (_service, _operation, request) => {
    calls++;
    if (calls === 1) return { EvaluationResults: [], IsTruncated: true, Marker: 'page-2' };
    assert.equal(request.Marker, 'page-2');
    return { EvaluationResults: [{ EvalActionName: requirement.action,
      EvalResourceName: requirement.resource, EvalDecision: 'allowed' }] };
  });
  assert.equal(calls, 2); assert.equal(results[0].allowed, true);
  await assert.rejects(simulate([requirement], async () => ({ EvaluationResults: [], IsTruncated: true })),
    /Incomplete IAM simulation/);
});

test('failure output deduplicates denied pairs and suggests only their exact scopes and conditions', () => {
  const denied = { action: 'iam:PassRole', resource: 'arn:aws:iam::240742387601:role/lab-execution',
    allowed: false, outcome: 'denied', decision: 'implicitDeny', context: [
      { ContextKeyName: 'iam:PassedToService', ContextKeyValues: ['lambda.amazonaws.com'], ContextKeyType: 'string' }
    ] };
  const unverified = { action: 'lambda:CreateFunction', resource: 'arn:aws:lambda:eu-west-1:240742387601:function:lab',
    allowed: false, outcome: 'unverified', decision: 'missing context: aws:SourceIp' };
  const verified = { action: 'lambda:GetFunction', resource: unverified.resource, allowed: true, decision: 'allowed' };
  const results = [denied, { ...denied }, unverified, verified];
  const issues = ['Unsupported resource/data source: aws_unknown.lab'];
  assert.deepEqual(failureAnnotations(results, issues), [
    `::error::Denied deployer permission: ${denied.action} on ${denied.resource}`,
    `::error::Unverified deployer permission: ${unverified.action} on ${unverified.resource}`,
    `::error::Cannot verify deployer permissions: ${issues[0]}`
  ]);
  const summary = report(results, issues);
  assert.match(summary, /\| Required IAM action \| Resource \|/); // Detailed table preserved.
  assert.match(summary, /FAIL/);
  const final = summary.split('### Final failure summary')[1];
  assert.equal(final.split(`- ${denied.action} → ${denied.resource}`).length - 1, 1);
  assert.ok(!final.includes(verified.action));
  assert.match(final, /Unresolved \/ unverified.*\n.*lambda:CreateFunction/);
  assert.match(final, /Suggested IAM policy/);
  const policy = JSON.parse(final.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.deepEqual(policy, { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['iam:PassRole'],
    Resource: [denied.resource], Condition: { StringEquals: { 'iam:PassedToService': ['lambda.amazonaws.com'] } } }] });
});

test('unverified-only failures never suggest grants, while successful checks emit no errors or policy', () => {
  const result = { action: 's3:ListBucket', resource: 'arn:aws:s3:::lab-state', allowed: false, decision: 'not evaluated' };
  const failure = report([result], ['Simulation could not complete']);
  assert.match(failure, /Denied IAM actions and resource scopes:\n- none/);
  assert.match(failure, /No policy suggested/);
  assert.ok(!failure.includes('```json'));
  assert.match(failure, /FAIL/);
  const allowed = { ...result, allowed: true, decision: 'allowed' };
  assert.deepEqual(failureAnnotations([allowed], []), []);
  assert.match(report([allowed], []), /PASS/);
  assert.ok(!report([allowed], []).includes('Suggested IAM policy'));
});

test('annotations escape workflow commands and duplicate unresolved issues', () => {
  const issue = 'bad%\r\n::warning::injected';
  assert.deepEqual(failureAnnotations([], [issue, issue]),
    ['::error::Cannot verify deployer permissions: bad%25%0D%0A::warning::injected']);
});

test('policy output deduplicates scopes while retaining condition alternatives without cross-products', () => {
  const pair = { action: 'iam:DetachRolePolicy', resource: 'arn:aws:iam::240742387601:role/lab',
    allowed: false, decision: 'implicitDeny' };
  const context = value => [{ ContextKeyName: 'iam:PolicyARN', ContextKeyValues: [value], ContextKeyType: 'string' }];
  const results = [{ ...pair, context: context('arn:aws:iam::aws:policy/First') },
    { ...pair, context: context('arn:aws:iam::aws:policy/Second') },
    { ...pair, resource: pair.resource + '-other' }];
  const output = report(results, []);
  const policy = JSON.parse(output.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(failureAnnotations(results, []).length, 2);
  assert.equal(policy.Statement.length, 2);
  assert.deepEqual(policy.Statement[0].Condition.StringEquals['iam:PolicyARN'],
    ['arn:aws:iam::aws:policy/First', 'arn:aws:iam::aws:policy/Second']);
  const ambiguous = report([results[0], { ...pair, context: [
    ...context('arn:aws:iam::aws:policy/Second'),
    { ContextKeyName: 'aws:Other', ContextKeyValues: ['value'], ContextKeyType: 'string' }
  ] }], []);
  assert.ok(!ambiguous.includes('```json'));
  assert.match(ambiguous, /differing condition contexts require manual review/);
  assert.match(ambiguous, /FAIL/);
});

test('simulation distinguishes real denials from incomplete verification without changing failure decisions', async () => {
  const requirement = { action: 's3:ListBucket', resource: 'arn:aws:s3:::lab-bucket' };
  for (const [details, outcome] of [
    [{ EvalDecision: 'implicitDeny' }, 'denied'],
    [{ EvalDecision: 'explicitDeny' }, 'denied'],
    [{ EvalDecision: 'allowed', PermissionsBoundaryDecisionDetail: { AllowedByPermissionsBoundary: false } }, 'denied'],
    [{ EvalDecision: 'allowed', OrganizationsDecisionDetail: { AllowedByOrganizations: false } }, 'denied'],
    [{ EvalDecision: 'allowed', ResourceSpecificResults: [{ EvalResourceDecision: 'explicitDeny' }] }, 'denied'],
    [{ EvalDecision: 'implicitDeny', MissingContextValues: ['aws:SourceIp'] }, 'unverified'],
    [{ EvalDecision: 'allowed', ResourceSpecificResults: [{ EvalResourceDecision: 'allowed', MissingContextValues: ['aws:SourceIp'] }] }, 'unverified']
  ]) {
    const [result] = await simulate([requirement], async () => ({ EvaluationResults: [{
      EvalActionName: requirement.action, EvalResourceName: requirement.resource, ...details
    }] }));
    assert.equal(result.allowed, false);
    assert.equal(result.outcome, outcome);
  }
  const [missing] = await simulate([requirement], async () => ({ EvaluationResults: [] }));
  assert.equal(missing.outcome, 'unverified');
});

test('workflow contains no apply, no PR write permission, and uses a read-only plan', () => {
  const workflow = readFileSync('.github/workflows/terraform-permission-check.yml', 'utf8');
  assert.ok(!/run:.*terraform apply/.test(workflow));
  assert.ok(!workflow.includes('pull-requests: write'));
  assert.match(workflow, /terraform plan -lock=false/);
  assert.match(workflow, /github-terraform-plan-checker/);
  assert.ok(!workflow.includes('needs:'));
  assert.ok(!workflow.includes('pull_request_target'));
});

const executionRole = 'arn:aws:iam::240742387601:role/lab-execution';
const valuesByType = {
  aws_iam_role: { name: 'lab-execution', path: '/', assume_role_policy: '{}', description: '', max_session_duration: 3600 },
  aws_iam_role_policy: { name: 'logs', role: executionRole, policy: '{}' },
  aws_cloudwatch_log_group: { name: '/aws/lambda/lab', retention_in_days: 1 },
  aws_lambda_function: { function_name: 'lab', role: executionRole, filename: 'function.zip', source_code_hash: 'hash',
    handler: 'index.handler', runtime: 'nodejs24.x', architectures: ['arm64'], memory_size: 128, timeout: 3,
    reserved_concurrent_executions: -1, package_type: 'Zip', publish: false }
};
function extendedPlan(resources) {
  const result = plan(resources);
  result.configuration.root_module.resources.forEach(r => { r.expressions = {}; });
  return result;
}
function mapped(type, actions, before, after) {
  return requiredPermissions(extendedPlan([resource(type, actions, before, after)]), backend);
}
function mutations(result) {
  return [...new Set(result.requirements.map(r => r.action).filter(a =>
    /^(lambda|iam|logs):/.test(a) && !/:(Get|List|Describe)/.test(a)))].sort();
}

for (const [type, expected] of Object.entries({
  aws_iam_role: { create: ['iam:CreateRole'], update: ['iam:UpdateRoleDescription'], delete: ['iam:DeleteRole'] },
  aws_iam_role_policy: { create: ['iam:PutRolePolicy'], update: ['iam:PutRolePolicy'], delete: ['iam:DeleteRolePolicy'] },
  aws_cloudwatch_log_group: { create: ['logs:CreateLogGroup', 'logs:PutRetentionPolicy'], update: ['logs:PutRetentionPolicy'], delete: ['logs:DeleteLogGroup'] },
  aws_lambda_function: { create: ['iam:PassRole', 'lambda:CreateFunction'], update: ['lambda:UpdateFunctionCode'], delete: ['lambda:DeleteFunction'] }
})) {
  test(`${type}: separates create, update, delete and refresh`, () => {
    const before = valuesByType[type];
    const after = { ...before, ...({ aws_iam_role: { description: 'changed' }, aws_iam_role_policy: { policy: '{"Version":"2012-10-17"}' },
      aws_cloudwatch_log_group: { retention_in_days: 7 }, aws_lambda_function: { source_code_hash: 'changed' } }[type]) };
    for (const [operation, old, next] of [['create', null, before], ['update', before, after], ['delete', before, null], ['no-op', before, before]]) {
      const result = mapped(type, [operation], old, next);
      assert.deepEqual(result.issues, []);
      assert.deepEqual(mutations(result), (expected[operation] ?? []).sort());
      assert.ok(result.requirements.some(r => /^(iam|lambda|logs):(Get|List|Describe)/.test(r.action)));
      assert.ok(result.requirements.filter(r => r.resource === '*').every(r => r.action === 'logs:DescribeLogGroups'));
    }
  });
}

test('Lambda configuration updates and role dependencies are conditional and concretely scoped', async () => {
  const before = valuesByType.aws_lambda_function;
  const timeout = mapped('aws_lambda_function', ['update'], before, { ...before, timeout: 5 });
  assert.deepEqual(mutations(timeout), ['lambda:UpdateFunctionConfiguration']);
  const result = mapped('aws_lambda_function', ['update'], before, { ...before, role: executionRole + '-new' });
  assert.deepEqual(mutations(result), ['iam:PassRole', 'lambda:UpdateFunctionConfiguration']);
  const pass = result.requirements.find(r => r.action === 'iam:PassRole');
  assert.equal(pass.resource, executionRole + '-new');
  await simulate([pass], async (_service, _operation, request) => {
    assert.ok(request.ContextEntries.some(c => c.ContextKeyName === 'iam:PassedToService' && c.ContextKeyValues[0] === 'lambda.amazonaws.com'));
    return { EvaluationResults: [{ EvalActionName: pass.action, EvalResourceName: pass.resource, EvalDecision: 'allowed' }] };
  });
});

test('log retention removal, skip_destroy and tagging map only the requested operations', () => {
  const log = valuesByType.aws_cloudwatch_log_group;
  assert.deepEqual(mutations(mapped('aws_cloudwatch_log_group', ['update'], log, { ...log, retention_in_days: 0 })), ['logs:DeleteRetentionPolicy']);
  assert.deepEqual(mutations(mapped('aws_cloudwatch_log_group', ['delete'], { ...log, skip_destroy: true }, null)), []);
  assert.deepEqual(mutations(mapped('aws_lambda_function', ['delete'], { ...valuesByType.aws_lambda_function, skip_destroy: true }, null)), []);
  for (const [type, prefix, suffix] of [['aws_iam_role', 'iam', 'Role'], ['aws_cloudwatch_log_group', 'logs', 'Resource'], ['aws_lambda_function', 'lambda', 'Resource']]) {
    const before = { ...valuesByType[type], tags_all: { remove: 'old' } };
    const result = mapped(type, ['update'], before, { ...before, tags_all: { add: 'new' } });
    assert.deepEqual(mutations(result), [`${prefix}:Tag${suffix}`, `${prefix}:Untag${suffix}`]);
  }
});

test('IAM trust and session updates, deletion cleanup and policy ARN conditions are mapped', () => {
  const before = valuesByType.aws_iam_role;
  assert.deepEqual(mutations(mapped('aws_iam_role', ['update'], before, { ...before, assume_role_policy: 'changed', max_session_duration: 7200 })),
    ['iam:UpdateAssumeRolePolicy', 'iam:UpdateRole']);
  const result = mapped('aws_iam_role', ['delete'], { ...before, inline_policy: [{ name: 'logs' }], managed_policy_arns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] }, null);
  assert.deepEqual(mutations(result), ['iam:DeleteRole', 'iam:DeleteRolePolicy', 'iam:DetachRolePolicy']);
  assert.ok(result.requirements.some(r => r.action === 'iam:ListInstanceProfilesForRole'));
  assert.deepEqual(result.inspections, [{ roleName: 'lab-execution', address: 'aws_iam_role.example' }]);
  assert.equal(result.requirements.find(r => r.action === 'iam:DetachRolePolicy').context[0].ContextKeyName, 'iam:PolicyARN');
});

test('replacements retain old deletion scopes and new creation scopes for every new managed type', () => {
  for (const [type, field, oldValue, newValue, deleting, creating] of [
    ['aws_iam_role', 'name', 'old-role', 'new-role', 'iam:DeleteRole', 'iam:CreateRole'],
    ['aws_iam_role_policy', 'role', executionRole, executionRole + '-new', 'iam:DeleteRolePolicy', 'iam:PutRolePolicy'],
    ['aws_cloudwatch_log_group', 'name', '/old', '/new', 'logs:DeleteLogGroup', 'logs:CreateLogGroup'],
    ['aws_lambda_function', 'function_name', 'old-function', 'new-function', 'lambda:DeleteFunction', 'lambda:CreateFunction']
  ]) {
    const result = mapped(type, ['delete', 'create'], { ...valuesByType[type], [field]: oldValue }, { ...valuesByType[type], [field]: newValue });
    assert.deepEqual(result.issues, []);
    assert.ok(result.requirements.find(r => r.action === deleting).resource.includes(oldValue));
    assert.ok(result.requirements.find(r => r.action === creating).resource.includes(newValue));
  }
});

function lambdaCreationPlan() {
  const role = resource('aws_iam_role', ['create'], null, { ...valuesByType.aws_iam_role, name: 'agentic-sdlc-lab-hello-execution' });
  role.address = 'aws_iam_role.lab_lambda';
  const policy = resource('aws_iam_role_policy', ['create'], null, { name: 'write-function-logs', role: null, policy: null });
  policy.address = 'aws_iam_role_policy.lab_lambda_logs'; policy.change.after_unknown = { role: true, policy: true };
  const lambda = resource('aws_lambda_function', ['create'], null, { ...valuesByType.aws_lambda_function, function_name: 'agentic-sdlc-lab-hello', role: null });
  lambda.address = 'aws_lambda_function.lab'; lambda.change.after_unknown = { role: true, tags_all: true };
  const logs = resource('aws_cloudwatch_log_group', ['create'], null, { ...valuesByType.aws_cloudwatch_log_group, name: '/aws/lambda/agentic-sdlc-lab-hello' });
  logs.address = 'aws_cloudwatch_log_group.lab_lambda'; logs.change.after_unknown = { tags_all: true, log_group_class: true };
  const result = extendedPlan([role, policy, lambda, logs]);
  const configs = result.configuration.root_module.resources;
  configs.find(r => r.type === 'aws_lambda_function').expressions.role = { references: ['aws_iam_role.lab_lambda.arn', 'aws_iam_role.lab_lambda'] };
  configs.find(r => r.type === 'aws_iam_role_policy').expressions.role = { references: ['aws_iam_role.lab_lambda.id', 'aws_iam_role.lab_lambda'] };
  result.configuration.provider_config.archive = { full_name: 'registry.terraform.io/hashicorp/archive', expressions: {} };
  configs.push({ address: 'data.archive_file.lab_lambda', type: 'archive_file', mode: 'data', provider_config_key: 'archive',
    expressions: { type: { constant_value: 'zip' }, source_file: {}, output_path: {} } });
  return result;
}

test('inspected Lambda configuration resolves direct new-role references, supports archive, and reports denied Lambda actions', async () => {
  const result = requiredPermissions(lambdaCreationPlan(), backend, { sources: [readFileSync('infra/lambda.tf', 'utf8')] });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.noAwsPermissions, ['data.archive_file.lab_lambda']);
  assert.equal(result.requirements.find(r => r.action === 'iam:PassRole').resource, 'arn:aws:iam::240742387601:role/agentic-sdlc-lab-hello-execution');
  assert.ok(!result.requirements.some(r => r.action === 'logs:PutLogEvents' || r.action === 'logs:CreateLogStream'));
  const results = await simulate(result.requirements, async (_s, _o, request) => ({ EvaluationResults: [{
    EvalActionName: request.ActionNames[0], EvalResourceName: request.ResourceArns[0],
    EvalDecision: request.ActionNames[0] === 'lambda:CreateFunction' ? 'implicitDeny' : 'allowed'
  }] }));
  const summary = report(results, result.issues, result.noAwsPermissions);
  assert.match(summary, /FAIL/); assert.match(summary, /Missing or unverified actions: lambda:CreateFunction/);
  assert.match(summary, /data.archive_file.lab_lambda.*no AWS IAM actions/);
});

test('archive read is explicitly local, generates no AWS actions, and rejects other providers', () => {
  const archive = { address: 'data.archive_file.lab_lambda', type: 'archive_file', mode: 'data',
    provider_name: 'registry.terraform.io/hashicorp/archive', change: { actions: ['read'], before: null, after: { type: 'zip' } } };
  const input = lambdaCreationPlan(); input.resource_changes = [archive];
  input.configuration.root_module.resources = input.configuration.root_module.resources.filter(r => r.type === 'archive_file');
  const result = requiredPermissions(input, backend);
  assert.deepEqual(result.issues, []);
  assert.ok(result.requirements.every(r => r.reasons.every(reason => !reason.includes('archive_file'))));
  archive.provider_name = provider;
  assert.ok(requiredPermissions(input, backend).issues.length);
});

test('unknown role references are never inferred from non-direct HCL or references alone', () => {
  const input = lambdaCreationPlan();
  assert.ok(requiredPermissions(input, backend).issues.some(i => i.includes('Unknown Lambda execution-role')));
  const sources = ['resource "aws_lambda_function" "lab" {\n role = format("%s", aws_iam_role.lab_lambda.arn)\n}'];
  assert.equal(directRoleBindings(sources).size, 0);
  for (const expression of ['aws_iam_role.lab_lambda.arn != "" ? aws_iam_role.lab_lambda.arn : "other"', 'aws_iam_role.lab_lambda.arn + "extra"'])
    assert.equal(directRoleBindings([`resource "aws_lambda_function" "lab" {\n role = ${expression}\n}`]).size, 0);
  const decoys = '# resource "aws_lambda_function" "lab" { role = aws_iam_role.lab_lambda.arn }\n' +
    'locals { text = <<EOF\nresource "aws_lambda_function" "lab" { role = aws_iam_role.lab_lambda.arn }\nEOF\n}';
  assert.equal(directRoleBindings([decoys]).size, 0);
  const config = input.configuration.root_module.resources.find(r => r.type === 'aws_lambda_function');
  config.expressions.role.references.push('var.other');
  assert.ok(requiredPermissions(input, backend, { sources: [readFileSync('infra/lambda.tf', 'utf8')] }).issues.some(i => i.includes('Unknown Lambda execution-role')));
  config.expressions.role.references.pop();
  input.resource_changes.find(r => r.type === 'aws_lambda_function').change.after_unknown.role = false;
  assert.ok(requiredPermissions(input, backend, { sources: [readFileSync('infra/lambda.tf', 'utf8')] }).issues.some(i => i.includes('Unknown Lambda execution-role')));
});

test('unsupported variants, unresolved scopes and configured unknown tags continue to fail closed', () => {
  for (const [type, extra] of [['aws_lambda_function', { publish: true }], ['aws_lambda_function', { vpc_config: [{}] }],
    ['aws_lambda_function', { role: 'arn:aws:iam::999999999999:role/other' }], ['aws_iam_role', { force_detach_policies: true }],
    ['aws_iam_role', { path: null }], ['aws_cloudwatch_log_group', { kms_key_id: 'key' }],
    ['aws_cloudwatch_log_group', { log_group_class: 'INFREQUENT_ACCESS' }]])
    assert.ok(mapped(type, ['create'], null, { ...valuesByType[type], ...extra }).issues.length, `${type} ${JSON.stringify(extra)}`);
  const input = extendedPlan([resource('aws_lambda_function', ['create'], null, valuesByType.aws_lambda_function)]);
  input.resource_changes[0].change.after_unknown.tags_all = true;
  input.configuration.root_module.resources[0].expressions.tags = { references: ['var.tags'] };
  assert.ok(requiredPermissions(input, backend).issues.some(i => i.includes('Unknown tags')));
});

test('mixed resource permissions preserve S3 policy checks without treating IAM/Lambda/log ARNs as buckets', () => {
  const result = requiredPermissions(lambdaCreationPlan(), backend, { sources: [readFileSync('infra/lambda.tf', 'utf8')] });
  assert.deepEqual(s3Buckets(result.requirements), ['lab-state']);
});

test('IAM role deletion inspection is read-only and fails closed on instance profiles or incomplete responses', async () => {
  const inspections = [{ roleName: 'lab-execution', address: 'aws_iam_role.example' }];
  for (const response of [{ InstanceProfiles: [] }, { InstanceProfiles: [{}] }, { InstanceProfiles: [], IsTruncated: true }, {}]) {
    const issues = await verifyRoleProfiles(inspections, async (service, operation, request) => {
      assert.equal(service, 'iam'); assert.equal(operation, 'list-instance-profiles-for-role');
      assert.deepEqual(request, { RoleName: 'lab-execution' });
      return response;
    });
    assert.equal(issues.length, Array.isArray(response.InstanceProfiles) && !response.InstanceProfiles.length && !response.IsTruncated ? 0 : 1);
  }
  await assert.rejects(verifyRoleProfiles(inspections, async () => { throw new Error('AccessDenied'); }), /AccessDenied/);
});

test('unknown retention and unmapped role creation dependencies cannot be certified', () => {
  const input = extendedPlan([resource('aws_cloudwatch_log_group', ['create'], null, { name: '/lab', retention_in_days: null })]);
  input.resource_changes[0].change.after_unknown.retention_in_days = true;
  assert.ok(requiredPermissions(input, backend).issues.some(i => i.includes('Unknown retention')));
  assert.ok(mapped('aws_iam_role', ['create'], null, { ...valuesByType.aws_iam_role, permissions_boundary: 'policy' }).issues.length);
});

const gatewayBase = 'arn:aws:apigateway:eu-west-1::/apis';
const apiValues = {
  aws_apigatewayv2_api: { id: 'api123', name: 'lab-http', protocol_type: 'HTTP' },
  aws_apigatewayv2_integration: { id: 'int123', api_id: 'api123', integration_type: 'AWS_PROXY',
    integration_uri: 'arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:240742387601:function:lab/invocations',
    integration_method: 'POST', payload_format_version: '2.0' },
  aws_apigatewayv2_route: { id: 'route123', api_id: 'api123', route_key: 'GET /hello', authorization_type: 'NONE', target: 'integrations/int123' },
  aws_apigatewayv2_stage: { id: '$default', api_id: 'api123', name: '$default', auto_deploy: true },
  aws_lambda_permission: { function_name: 'lab', statement_id: 'AllowHelloHttpApi', action: 'lambda:InvokeFunction',
    principal: 'apigateway.amazonaws.com', source_arn: 'arn:aws:execute-api:eu-west-1:240742387601:api123/$default/GET/hello' }
};
const apiPaths = { aws_apigatewayv2_api: '/api123', aws_apigatewayv2_integration: '/api123/integrations/int123',
  aws_apigatewayv2_route: '/api123/routes/route123', aws_apigatewayv2_stage: '/api123/stages/$default' };

for (const type of Object.keys(apiPaths)) {
  test(`${type}: maps exact management verbs and paths for create/update/delete/refresh`, () => {
    const before = apiValues[type];
    const collection = apiPaths[type].substring(0, apiPaths[type].lastIndexOf('/'));
    const update = type === 'aws_apigatewayv2_route' ? { route_key: 'GET /new' } : { description: 'changed' };
    for (const [operation, old, after, verb] of [['create', null, before, 'POST'], ['update', before, { ...before, ...update }, 'PATCH'],
      ['delete', before, null, 'DELETE'], ['no-op', before, before, null]]) {
      const result = mapped(type, [operation], old, after);
      assert.deepEqual(result.issues, []);
      const permissions = result.requirements.filter(r => r.action.startsWith('apigateway:'));
      assert.ok(permissions.some(r => r.action === 'apigateway:GET' && r.resource === gatewayBase + apiPaths[type]));
      assert.deepEqual(permissions.filter(r => r.action !== 'apigateway:GET').map(r => [r.action, r.resource]),
        verb ? [[`apigateway:${verb}`, operation === 'create' ? gatewayBase + collection : gatewayBase + apiPaths[type]]] : []);
      if (type === 'aws_apigatewayv2_stage') assert.ok(permissions.some(r => r.action === 'apigateway:GET' && r.resource === gatewayBase + '/api123'));
      assert.ok(permissions.every(r => !r.resource.includes('*')));
    }
  });
}

test('API Gateway replacements scope delete to old objects and create to new collections', () => {
  for (const type of Object.keys(apiPaths)) {
    const before = apiValues[type];
    const after = { ...before, id: 'new123', ...(type === 'aws_apigatewayv2_api' ? {} : { api_id: 'newapi123' }),
      ...(type === 'aws_apigatewayv2_stage' ? { name: 'newstage' } : {}) };
    const result = mapped(type, ['delete', 'create'], before, after);
    assert.deepEqual(result.issues, []);
    assert.ok(result.requirements.some(r => r.action === 'apigateway:DELETE' && r.resource === gatewayBase + apiPaths[type]));
    const post = result.requirements.find(r => r.action === 'apigateway:POST');
    assert.equal(post.resource, type === 'aws_apigatewayv2_api' ? gatewayBase : `${gatewayBase}/newapi123/${type.split('_').at(-1)}s`);
    assert.ok(!result.requirements.some(r => r.action === 'apigateway:DELETE' && r.resource.includes('new')));
  }
});

test('Lambda permission maps policy reads, create/delete and replacement without deployer InvokeFunction', async () => {
  const before = apiValues.aws_lambda_permission;
  const arn = 'arn:aws:lambda:eu-west-1:240742387601:function:lab';
  for (const [operation, old, after, action] of [['create', null, before, 'lambda:AddPermission'],
    ['delete', before, null, 'lambda:RemovePermission'], ['no-op', before, before, null]]) {
    const result = mapped('aws_lambda_permission', [operation], old, after);
    assert.deepEqual(result.issues, []);
    const perms = result.requirements.filter(r => r.action.startsWith('lambda:'));
    assert.deepEqual(new Set(perms.map(r => r.action)), new Set(['lambda:GetPolicy', ...(action ? [action] : [])]));
    assert.ok(perms.every(r => r.resource === arn));
    const mutation = perms.find(r => r.action === action);
    if (mutation) {
      await simulate([mutation], async (_service, _operation, request) => {
        assert.ok(request.ContextEntries.some(c => c.ContextKeyName === 'lambda:Principal' && c.ContextKeyValues[0] === before.principal));
        return { EvaluationResults: [{ EvalActionName: mutation.action, EvalResourceName: arn, EvalDecision: 'allowed' }] };
      });
    }
  }
  const replacement = mapped('aws_lambda_permission', ['delete', 'create'], before, { ...before, function_name: 'new-function' });
  assert.ok(replacement.requirements.some(r => r.action === 'lambda:RemovePermission' && r.resource === arn));
  assert.ok(replacement.requirements.some(r => r.action === 'lambda:AddPermission' && r.resource.endsWith(':new-function')));
  assert.ok(mapped('aws_lambda_permission', ['update'], before, { ...before, source_arn: 'changed' }).issues.length);
  assert.deepEqual(mapped('aws_lambda_permission', ['create'], null, { ...before, function_name: arn }).issues, []);
});

test('unknown AWS-generated API/child IDs fail closed and never use wildcard or old replacement scopes', () => {
  for (const type of Object.keys(apiPaths)) {
    const before = apiValues[type];
    const after = { ...before, ...(type === 'aws_apigatewayv2_api' ? { id: null } : { api_id: null }) };
    const result = mapped(type, ['delete', 'create'], before, after);
    assert.ok(result.issues.some(i => i.includes('Unverified API Gateway ID')));
    assert.ok(!result.requirements.some(r => r.action === 'apigateway:POST' && r.resource !== gatewayBase));
    assert.ok(result.requirements.every(r => !r.resource.includes('*')));
    assert.match(report([], result.issues), /FAIL/);
  }
  for (const type of ['aws_apigatewayv2_integration', 'aws_apigatewayv2_route']) {
    const result = mapped(type, ['create'], null, { ...apiValues[type], id: null });
    assert.ok(result.issues.some(i => i.includes('child ID')));
    assert.ok(result.requirements.some(r => r.action === 'apigateway:POST')); // Known collection; post-create read still unverified.
  }
});

test('API Gateway and Lambda permission variants and unknown function scopes stay unsupported', () => {
  for (const [type, extra] of [['aws_apigatewayv2_api', { protocol_type: 'WEBSOCKET' }],
    ['aws_apigatewayv2_api', { tags_all: { lab: 'test' } }],
    ['aws_apigatewayv2_integration', { credentials_arn: executionRole }],
    ['aws_apigatewayv2_integration', { integration_type: 'HTTP_PROXY' }],
    ['aws_apigatewayv2_route', { authorization_type: 'CUSTOM' }],
    ['aws_apigatewayv2_stage', { access_log_settings: [{}] }],
    ['aws_lambda_permission', { qualifier: 'live' }],
    ['aws_lambda_permission', { principal: 's3.amazonaws.com' }],
    ['aws_lambda_permission', { function_name: null }],
    ['aws_lambda_permission', { function_name: 'arn:aws:lambda:us-east-1:999999999999:function:other' }]])
    assert.ok(mapped(type, ['create'], null, { ...apiValues[type], ...extra }).issues.length, `${type} ${JSON.stringify(extra)}`);
  const input = extendedPlan([resource('aws_apigatewayv2_api', ['create'], null, apiValues.aws_apigatewayv2_api)]);
  input.configuration.root_module.resources[0].expressions.body = {};
  assert.ok(requiredPermissions(input, backend).issues.some(i => i.includes('.body')));
});

test('new mappings identify denied management and Lambda authorization actions in summaries', async () => {
  const input = extendedPlan(Object.entries(apiValues).map(([type, values]) => resource(type, ['create'], null, values)));
  const mapping = requiredPermissions(input, backend);
  assert.deepEqual(mapping.issues, []);
  const results = await simulate(mapping.requirements, async (_service, _operation, request) => ({ EvaluationResults: [{
    EvalActionName: request.ActionNames[0], EvalResourceName: request.ResourceArns[0],
    EvalDecision: ['apigateway:POST', 'lambda:AddPermission'].includes(request.ActionNames[0]) ? 'implicitDeny' : 'allowed'
  }] }));
  assert.match(report(results, mapping.issues), /Missing or unverified actions: apigateway:POST, lambda:AddPermission/);
  assert.match(report(results, mapping.issues), /FAIL/);
  assert.match(report(results.map(r => ({ ...r, allowed: true })), mapping.issues), /PASS/);
});
