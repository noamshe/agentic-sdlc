import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ACCOUNT = '240742387601';
const REGION = 'eu-west-1';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/github-terraform-deployer`;
const PROVIDER = 'registry.terraform.io/hashicorp/aws';

// IAM action names (not SDK operation names). Reads include provider refresh/waiters.
// Source: hashicorp/terraform-provider-aws internal/service/s3, AWS S3 authorization reference.
const specs = {
  aws_s3_bucket: {
    attributes: ['bucket', 'bucket_prefix', 'force_destroy', 'tags', 'region'],
    read: ['ListBucket', 'GetBucketLocation', 'GetBucketPolicy', 'GetBucketAcl', 'GetBucketCORS',
      'GetBucketWebsite', 'GetBucketVersioning', 'GetBucketLogging', 'GetBucketRequestPayment',
      'GetAccelerateConfiguration', 'GetReplicationConfiguration', 'GetLifecycleConfiguration',
      'GetEncryptionConfiguration', 'GetBucketObjectLockConfiguration', 'GetBucketTagging'],
    write: [], remove: ['DeleteBucket']
  },
  aws_s3_bucket_public_access_block: {
    attributes: ['bucket', 'block_public_acls', 'block_public_policy', 'ignore_public_acls',
      'restrict_public_buckets', 'skip_destroy', 'region'],
    read: ['GetBucketPublicAccessBlock'], write: ['PutBucketPublicAccessBlock'],
    remove: ['PutBucketPublicAccessBlock']
  },
  aws_s3_bucket_ownership_controls: {
    attributes: ['bucket', 'rule', 'region'], read: ['GetBucketOwnershipControls'],
    write: ['PutBucketOwnershipControls'], remove: ['DeleteBucketOwnershipControls']
  },
  aws_s3_bucket_server_side_encryption_configuration: {
    attributes: ['bucket', 'rule', 'expected_bucket_owner', 'region'],
    read: ['GetEncryptionConfiguration'], write: ['PutEncryptionConfiguration'],
    remove: ['PutEncryptionConfiguration']
  }
};

function configuredResources(module) {
  return [...(module?.resources ?? []), ...Object.values(module?.module_calls ?? {})
    .flatMap(call => configuredResources(call.module))];
}
function bucketArn(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)) return null;
  return `arn:aws:s3:::${name}`;
}

export function requiredPermissions(plan, backendState) {
  if (!plan || !/^1\./.test(plan.format_version ?? '') || !Array.isArray(plan.resource_changes))
    throw new Error('Missing/unsupported Terraform plan JSON');
  const issues = [], requirements = new Map();
  if (plan.errored || plan.complete === false || plan.deferred_changes?.length)
    issues.push('Plan is incomplete, errored, or contains deferred changes');
  const add = (action, resource, reason) => {
    const key = `${action}|${resource}`;
    if (!requirements.has(key)) requirements.set(key, { action, resource, reasons: [] });
    requirements.get(key).reasons.push(reason);
  };
  for (const resource of configuredResources(plan.configuration?.root_module)) {
    const spec = Object.hasOwn(specs, resource.type) ? specs[resource.type] : null;
    if (resource.mode !== 'managed' || !spec) {
      issues.push(`Unsupported resource/data source: ${resource.address}`); continue;
    }
    for (const attribute of Object.keys(resource.expressions ?? {}))
      if (!spec.attributes.includes(attribute)) issues.push(`Unmapped configuration: ${resource.address}.${attribute}`);
  }
  const providers = Object.values(plan.configuration?.provider_config ?? {});
  if (!providers.length) issues.push('Missing provider configuration');
  for (const provider of providers) {
    if (provider.full_name !== PROVIDER || provider.alias ||
        provider.expressions?.region?.constant_value !== REGION ||
        Object.keys(provider.expressions ?? {}).some(key => key !== 'region'))
      issues.push('Only the default AWS provider in eu-west-1, without additional settings, is mapped');
  }
  for (const resource of plan.resource_changes) {
    const spec = Object.hasOwn(specs, resource.type) ? specs[resource.type] : null;
    if (!spec || resource.mode !== 'managed' || resource.provider_name !== PROVIDER) {
      issues.push(`Unmapped plan resource: ${resource.address}`); continue;
    }
    if (resource.previous_address || resource.change?.importing)
      issues.push(`Move/import is not mapped: ${resource.address}`);
    const change = resource.change;
    if (!change || !Array.isArray(change.actions) ||
        change.actions.some(action => !['create', 'update', 'delete', 'no-op'].includes(action))) {
      issues.push(`Unmapped plan action: ${resource.address}`); continue;
    }
    const deleting = change.actions.includes('delete');
    const writing = change.actions.includes('create') || change.actions.includes('update');
    // Refresh existing resources even if their planned action is no-op.
    for (const [values, operations, phase] of [
      [change.before, [...spec.read, ...(deleting ? spec.remove : [])], 'existing'],
      [change.after, [...spec.read, ...(writing ? spec.write : [])], 'planned']
    ]) {
      if (!values) continue;
      const arn = bucketArn(values.bucket);
      if (!arn) {
        issues.push(`Unknown bucket name: ${resource.address} (${phase}); use an explicit name for deterministic simulation`);
        continue;
      }
      if (values.region && values.region !== REGION) issues.push(`Unmapped region: ${resource.address}`);
      if (values.force_destroy) issues.push(`force_destroy object deletion is not mapped: ${resource.address}`);
      if (values.expected_bucket_owner && values.expected_bucket_owner !== ACCOUNT)
        issues.push(`Cross-account bucket is not mapped: ${resource.address}`);
      if (resource.type === 'aws_s3_bucket_server_side_encryption_configuration' &&
          values.rule?.some(rule => rule.apply_server_side_encryption_by_default?.some(
            defaults => defaults.sse_algorithm !== 'AES256' || defaults.kms_master_key_id)))
        issues.push(`Only SSE-S3 AES256 encryption is mapped: ${resource.address}`);
      for (const action of operations) add(`s3:${action}`, arn, resource.address);
      if (phase === 'planned' && resource.type === 'aws_s3_bucket' && change.actions.includes('create'))
        add('s3:CreateBucket', arn, resource.address);
      if (phase === 'planned' && resource.type === 'aws_s3_bucket' && writing) {
        // Untagged bucket creation does not require PutBucketTagging. Legacy tagging
        // APIs are the provider fallback when newer S3 Control tagging is unavailable.
        const before = change.before?.tags_all ?? {};
        const after = change.after?.tags_all ?? {};
        if (JSON.stringify(before) !== JSON.stringify(after))
          add('s3:PutBucketTagging', arn, resource.address);
        if (change.after_unknown?.tags_all) issues.push(`Unknown bucket tags: ${resource.address}`);
      }
      if (phase === 'planned' && writing &&
          resource.type === 'aws_s3_bucket_server_side_encryption_configuration' && change.after_unknown?.rule)
        issues.push(`Unknown encryption configuration: ${resource.address}`);
    }
  }
  const backend = backendState?.backend;
  const config = backend?.config;
  if (backend?.type !== 's3' || !bucketArn(config?.bucket) || typeof config?.key !== 'string' || !config.key)
    issues.push('Expected initialized S3 backend with a concrete bucket and state key');
  else {
    if (config.region !== REGION || config.kms_key_id || config.dynamodb_table ||
        config.role_arn || config.assume_role?.length || config.assume_role_with_web_identity?.length ||
        config.endpoints && Object.values(config.endpoints).some(Boolean))
      issues.push('Backend region, KMS, DynamoDB, assume-role, or endpoint configuration is not mapped');
    const arn = bucketArn(config.bucket), object = `${arn}/${config.key}`;
    add('s3:ListBucket', arn, 'Terraform S3 backend');
    add('s3:GetObject', object, 'Terraform state read');
    add('s3:PutObject', object, 'Deployment state persistence (simulated only)');
    if (config.use_lockfile) {
      for (const action of ['GetObject', 'PutObject', 'DeleteObject'])
        add(`s3:${action}`, `${object}.tflock`, 'Deployment state locking (simulated only)');
    }
  }
  return { requirements: [...requirements.values()].sort((a, b) =>
    `${a.action}|${a.resource}`.localeCompare(`${b.action}|${b.resource}`)), issues: [...new Set(issues)] };
}

// These are the only AWS API calls the helper can make. None mutate AWS resources.
function aws(service, operation, request) {
  const allowed = ['iam:simulate-principal-policy', 's3api:get-bucket-policy', 's3api:get-bucket-encryption'];
  if (!allowed.includes(`${service}:${operation}`)) throw new Error('Non-read-only AWS operation rejected');
  try {
    return JSON.parse(execFileSync('aws', [service, operation, '--cli-input-json', JSON.stringify(request),
      '--region', REGION, '--output', 'json', '--no-cli-pager'],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    const match = /\((\w+)\) when calling/.exec(String(error.stderr ?? ''));
    throw Object.assign(new Error(`Read-only AWS ${service}:${operation} failed (${match?.[1] ?? 'CLI/network error'})`),
      { code: match?.[1] });
  }
}

export async function simulate(requirements, call = aws) {
  const results = [];
  for (const requirement of requirements) {
    const context = [
      { ContextKeyName: 'aws:RequestedRegion', ContextKeyValues: [REGION], ContextKeyType: 'string' },
      { ContextKeyName: 'aws:PrincipalArn', ContextKeyValues: [ROLE], ContextKeyType: 'string' }
    ];
    if (requirement.action === 's3:CreateBucket') context.push({ ContextKeyName: 's3:LocationConstraint',
      ContextKeyValues: [REGION], ContextKeyType: 'string' });
    const evaluations = [];
    let marker;
    do {
      const response = await call('iam', 'simulate-principal-policy', {
        PolicySourceArn: ROLE, ActionNames: [requirement.action], ResourceArns: [requirement.resource],
        ContextEntries: context, ...(marker ? { Marker: marker } : {})
      });
      if (!Array.isArray(response.EvaluationResults)) throw new Error('Invalid IAM simulation response');
      evaluations.push(...response.EvaluationResults);
      if (response.IsTruncated && (!response.Marker || response.Marker === marker))
        throw new Error('Incomplete IAM simulation response');
      marker = response.IsTruncated ? response.Marker : undefined;
    } while (marker);
    const evaluation = evaluations.find(item => item.EvalActionName === requirement.action &&
      item.EvalResourceName === requirement.resource);
    const contextMissing = evaluation?.MissingContextValues ?? [];
    const allowed = evaluation?.EvalDecision === 'allowed' && contextMissing.length === 0 &&
      evaluation?.PermissionsBoundaryDecisionDetail?.AllowedByPermissionsBoundary !== false &&
      evaluation?.OrganizationsDecisionDetail?.AllowedByOrganizations !== false &&
      (evaluation?.ResourceSpecificResults ?? []).every(item => item.EvalResourceDecision === 'allowed' &&
        !(item.MissingContextValues?.length));
    const decision = contextMissing.length ? `missing context: ${contextMissing.join(', ')}`
      : evaluation?.PermissionsBoundaryDecisionDetail?.AllowedByPermissionsBoundary === false ? 'permissions boundary deny'
      : evaluation?.OrganizationsDecisionDetail?.AllowedByOrganizations === false ? 'Organizations deny'
      : evaluation?.EvalDecision ?? 'missing result';
    results.push({ ...requirement, allowed, decision });
  }
  return results;
}

const safe = text => String(text).replace(/[\r\n|<>`]/g, ' ').replace(/@/g, '@\u200b');
export function report(results, issues) {
  const missing = [...new Set(results.filter(item => !item.allowed).map(item => item.action))];
  return ['## Terraform deployment permissions', '', `Deployment role: ${ROLE}`, '',
    'IAM simulation preflight only; not a guarantee of successful deployment. No AWS resources were changed.', '',
    '| Required IAM action | Resource | Available in simulation | Decision |',
    '| --- | --- | --- | --- |',
    ...results.map(item => `| ${safe(item.action)} | ${safe(item.resource)} | ${item.allowed ? 'Yes' : 'No'} | ${safe(item.decision)} |`), '',
    `Missing or unverified actions: ${missing.length ? missing.join(', ') : 'none'}`, '',
    ...issues.map(issue => `- Cannot verify: ${safe(issue)}`), '',
    missing.length || issues.length ? '**FAIL: missing permissions or incomplete verification.**'
      : '**PASS: all mapped action/resource pairs are allowed by IAM simulation.**', '',
    'Resource policies on roles, RCPs, endpoint policies, deployment-session restrictions, and future policy changes may differ from simulation.', ''
  ].join('\n');
}

export async function main() {
  if (process.env.DEPLOYER_ROLE_ARN !== ROLE) throw new Error('Unexpected deployment role');
  if (process.env.TF_WORKSPACE && process.env.TF_WORKSPACE !== 'default') throw new Error('Only default workspace is mapped');
  const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const backend = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const { requirements, issues } = requiredPermissions(plan, backend);
  let results = requirements.map(item => ({ ...item, allowed: false, decision: 'not evaluated' }));
  try {
    results = await simulate(requirements);
    // IAM cannot simulate resource-based policies for roles. Refuse to certify
    // buckets with such policies, including the backend, instead of ignoring them.
    const buckets = [...new Set(requirements.map(item => item.resource.split(':::')[1].split('/')[0]))];
    for (const bucket of buckets) {
      try {
        const policy = aws('s3api', 'get-bucket-policy', { Bucket: bucket, ExpectedBucketOwner: ACCOUNT });
        if (policy.Policy) issues.push(`Bucket policy on ${bucket} cannot be simulated for an IAM role`);
      } catch (error) {
        if (!['NoSuchBucketPolicy', 'NoSuchBucket'].includes(error.code)) throw error;
      }
    }
    if (backend.backend?.type === 's3' && bucketArn(backend.backend.config?.bucket)) {
      const encryption = aws('s3api', 'get-bucket-encryption', {
        Bucket: backend.backend.config.bucket, ExpectedBucketOwner: ACCOUNT
      });
      const rules = encryption.ServerSideEncryptionConfiguration?.Rules;
      if (!Array.isArray(rules) || !rules.length || rules.some(rule =>
          rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm !== 'AES256'))
        issues.push('Backend encryption is not SSE-S3; additional KMS permissions are not mapped');
    }
  } catch (error) {
    issues.push(error.message);
  }
  const summary = report(results, issues);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (issues.length || results.some(item => !item.allowed)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    const message = 'Terraform permission check failed: invalid inputs or checker configuration. No AWS changes were attempted.\n';
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
    process.exitCode = 1;
  });
}
