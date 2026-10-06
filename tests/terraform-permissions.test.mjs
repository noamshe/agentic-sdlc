import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requiredPermissions, simulate, report } from '../scripts/check-terraform-permissions.mjs';

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

test('workflow contains no apply, no PR write permission, and uses a read-only plan', () => {
  const workflow = readFileSync('.github/workflows/terraform-permission-check.yml', 'utf8');
  assert.ok(!/run:.*terraform apply/.test(workflow));
  assert.ok(!workflow.includes('pull-requests: write'));
  assert.match(workflow, /terraform plan -lock=false/);
  assert.match(workflow, /github-terraform-plan-checker/);
  assert.ok(!workflow.includes('needs:'));
  assert.ok(!workflow.includes('pull_request_target'));
});
