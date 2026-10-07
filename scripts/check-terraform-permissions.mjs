import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ACCOUNT = '240742387601';
const REGION = 'eu-west-1';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/github-terraform-deployer`;
const PROVIDER = 'registry.terraform.io/hashicorp/aws';
const ARCHIVE = 'registry.terraform.io/hashicorp/archive';

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
  },
  // Verified against AWS provider v6.67.0 (the failed run). Operation mapping below.
  // Sources and supported subsets: docs/terraform-permission-check.md.
  aws_cloudwatch_log_group: {
    attributes: ['name', 'name_prefix', 'retention_in_days', 'skip_destroy', 'tags', 'region'],
    extended: true
  },
  aws_iam_role: {
    attributes: ['name', 'name_prefix', 'path', 'assume_role_policy', 'description',
      'max_session_duration', 'force_detach_policies', 'tags'], extended: true
  },
  aws_iam_role_policy: {
    attributes: ['name', 'name_prefix', 'role', 'policy'], extended: true
  },
  aws_lambda_function: {
    attributes: ['function_name', 'role', 'filename', 'source_code_hash', 'handler', 'runtime',
      'architectures', 'memory_size', 'timeout', 'description', 'logging_config', 'tags',
      'publish', 'skip_destroy', 'region'], extended: true
  },
  archive_file: {
    attributes: ['type', 'source_file', 'output_path'], mode: 'data', provider: ARCHIVE, local: true
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

function roleArn(values) {
  if (!values || typeof values.name !== 'string' || !/^[\w+=,.@-]{1,64}$/.test(values.name) ||
      typeof values.path !== 'string' || !/^\/(?:[\w+=,.@-]+\/)*$/.test(values.path)) return null;
  return `arn:aws:iam::${ACCOUNT}:role${values.path}${values.name}`;
}
function validRoleArn(value) {
  return typeof value === 'string' && new RegExp(`^arn:aws:iam::${ACCOUNT}:role/(?:[\\w+=,.@-]+/)*[\\w+=,.@-]+$`).test(value);
}
const unknown = value => value === true || (value && typeof value === 'object' && Object.values(value).some(unknown));
const changed = (change, key) => unknown(change.after_unknown?.[key]) ||
  JSON.stringify(change.before?.[key] ?? null) !== JSON.stringify(change.after?.[key] ?? null);

// Plan JSON references alone do not prove a direct expression (format/conditionals
// also have references). Accept unknown role identities only for an exact, direct
// root-module HCL binding, checked against the plan's references as well.
export function directRoleBindings(sources) {
  const bindings = new Map();
  const lexer = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|<<-?(\w+)[^\n]*\n[\s\S]*?\n[ \t]*\1(?:\r?\n|$)|"(?:\\.|[^"\\])*"|[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*|[{}=]|\n|[^\s]/g;
  for (const source of sources) {
    const tokens = [...source.matchAll(lexer)].map(match => match[0])
      .filter(token => !/^(\/\*|\/\/|#)/.test(token));
    let depth = 0, address = null;
    for (let i = 0; i < tokens.length; i++) {
      if (depth === 0 && tokens[i] === 'resource' && /^"aws_(lambda_function|iam_role_policy)"$/.test(tokens[i + 1] ?? '') &&
          /^"[\w-]+"$/.test(tokens[i + 2] ?? '') && tokens[i + 3] === '{') {
        address = `${JSON.parse(tokens[i + 1])}.${JSON.parse(tokens[i + 2])}`;
        i += 3; depth = 1; continue;
      }
      if (tokens[i] === '{') depth++;
      else if (tokens[i] === '}') { depth--; if (depth === 0) address = null; }
      else if (address && depth === 1 && tokens[i] === 'role' && tokens[i + 1] === '=' &&
          /^aws_iam_role\.[\w-]+\.(arn|id|name)$/.test(tokens[i + 2] ?? '') &&
          ['\n', '}'].includes(tokens[i + 3])) bindings.set(address, tokens[i + 2]);
    }
  }
  return bindings;
}

function resolveRole(resource, phase, planResources, configuration, bindings) {
  const values = resource.change[phase];
  const value = values?.role;
  if (validRoleArn(value)) return value;
  // A known name must also have a uniquely known path in the inspected plan.
  if (typeof value === 'string' && /^[\w+=,.@-]{1,64}$/.test(value)) {
    const matches = planResources.filter(r => r.type === 'aws_iam_role' && r.mode === 'managed' &&
      r.provider_name === PROVIDER && r.change?.[phase]?.name === value)
      .map(r => roleArn(r.change[phase])).filter(Boolean);
    return matches.length === 1 ? matches[0] : null;
  }
  // Never infer an old identity from the current configuration during replacement.
  if (phase !== 'after' || value !== null && value !== undefined || !unknown(resource.change.after_unknown?.role)) return null;
  const binding = bindings.get(resource.address);
  if (!binding) return null;
  const expectedAttribute = resource.type === 'aws_lambda_function' ? 'arn' : '(?:id|name)';
  if (!new RegExp(`^aws_iam_role\\.[\\w-]+\\.${expectedAttribute}$`).test(binding)) return null;
  const target = binding.substring(0, binding.lastIndexOf('.'));
  const refs = configuration.get(resource.address)?.expressions?.role?.references ?? [];
  if (!refs.includes(binding) || refs.some(ref => ref !== binding && ref !== target)) return null;
  const matches = planResources.filter(r => r.address === target && r.type === 'aws_iam_role' &&
    r.mode === 'managed' && r.provider_name === PROVIDER);
  return matches.length === 1 ? roleArn(matches[0].change?.after) : null;
}

function mapExtended(resource, configuration, resources, bindings, add, issues, inspections) {
  const change = resource.change;
  const creating = change.actions.includes('create'), updating = change.actions.includes('update');
  const deleting = change.actions.includes('delete');
  const issue = message => issues.push(`${message}: ${resource.address}`);
  for (const phase of ['before', 'after']) {
    const values = change[phase];
    if (!values) continue;
    const create = phase === 'after' && creating, update = phase === 'after' && updating;
    const remove = phase === 'before' && deleting;
    if (values.region && values.region !== REGION) issue('Unmapped region');
    const action = (name, arn, context = []) => add(name, arn, resource.address, context);
    const tags = (prefix, arn) => {
      const oldTags = create ? {} : change.before?.tags_all ?? change.before?.tags ?? {};
      const newTags = values.tags_all ?? values.tags ?? {};
      if (!create && !update) return;
      // With no configured tags and no provider defaults, computed tags_all on
      // creation is not an unknown tagging request. Configured unknown tags fail.
      const configuredTags = configuration.get(resource.address)?.expressions?.tags;
      if (unknown(change.after_unknown?.tags) || unknown(change.after_unknown?.tags_all) && configuredTags) { issue('Unknown tags'); return; }
      if (Object.entries(newTags).some(([key, value]) => oldTags[key] !== value)) action(`${prefix}:Tag${prefix === 'iam' ? 'Role' : 'Resource'}`, arn);
      if (!create && Object.keys(oldTags).some(key => !Object.hasOwn(newTags, key))) action(`${prefix}:Untag${prefix === 'iam' ? 'Role' : 'Resource'}`, arn);
    };
    if (resource.type === 'aws_cloudwatch_log_group') {
      if (typeof values.name !== 'string' || !/^[\w./#-]{1,512}$/.test(values.name)) { issue('Unknown/unsupported log-group name'); continue; }
      const arn = `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${values.name}`;
      // DescribeLogGroups does not support resource-level authorization (AWS SAR).
      action('logs:DescribeLogGroups', '*');
      action('logs:ListTagsForResource', arn);
      if (values.kms_key_id || values.deletion_protection_enabled || values.log_group_class && values.log_group_class !== 'STANDARD')
        issue('KMS, deletion protection, or non-standard log groups are not mapped');
      if (create) action('logs:CreateLogGroup', `${arn}:*`);
      if (create && unknown(change.after_unknown?.retention_in_days)) issue('Unknown retention policy');
      if (create && (values.retention_in_days ?? 0) > 0 || update && changed(change, 'retention_in_days')) {
        if (unknown(change.after_unknown?.retention_in_days)) issue('Unknown retention policy');
        else action((values.retention_in_days ?? 0) > 0 ? 'logs:PutRetentionPolicy' : 'logs:DeleteRetentionPolicy', `${arn}:*`);
      }
      if (remove && !values.skip_destroy) action('logs:DeleteLogGroup', `${arn}:*`);
      tags('logs', arn);
    } else if (resource.type === 'aws_iam_role') {
      const arn = roleArn(values);
      if (!arn) { issue('Unknown/unsupported IAM role name or path'); continue; }
      for (const name of ['GetRole', 'ListRolePolicies', 'GetRolePolicy', 'ListAttachedRolePolicies']) action(`iam:${name}`, arn);
      if (values.force_detach_policies) issue('force_detach_policies is not mapped');
      if (create && (values.permissions_boundary || values.inline_policy?.length || values.managed_policy_arns?.length))
        issue('Creating boundaries or policies through aws_iam_role is not mapped');
      if (create) action('iam:CreateRole', arn);
      if (update) {
        for (const [field, name] of [['assume_role_policy', 'UpdateAssumeRolePolicy'], ['description', 'UpdateRoleDescription'],
          ['max_session_duration', 'UpdateRole']]) if (changed(change, field)) action(`iam:${name}`, arn);
        for (const field of ['permissions_boundary', 'managed_policy_arns', 'inline_policy'])
          if (changed(change, field)) issue(`Updating ${field} through aws_iam_role is not mapped`);
      }
      if (remove) {
        action('iam:DeleteRole', arn);
        action('iam:ListInstanceProfilesForRole', arn);
        inspections.push({ roleName: values.name, address: resource.address });
        if (values.inline_policy?.length) action('iam:DeleteRolePolicy', arn);
        for (const policy of values.managed_policy_arns ?? []) {
          if (typeof policy !== 'string' || !/^arn:aws:iam::(?:aws|240742387601):policy\/[\w+=,.@/-]+$/.test(policy)) issue('Unknown managed policy attachment');
          else action('iam:DetachRolePolicy', arn, [{ ContextKeyName: 'iam:PolicyARN', ContextKeyValues: [policy], ContextKeyType: 'string' }]);
        }
      }
      tags('iam', arn);
    } else if (resource.type === 'aws_iam_role_policy') {
      const arn = resolveRole(resource, phase, resources, configuration, bindings);
      if (!arn) { issue(`Unknown IAM policy role (${phase})`); continue; }
      action('iam:GetRolePolicy', arn);
      if (create || update) action('iam:PutRolePolicy', arn);
      if (remove) action('iam:DeleteRolePolicy', arn);
    } else if (resource.type === 'aws_lambda_function') {
      if (typeof values.function_name !== 'string' || !/^[\w-]{1,64}$/.test(values.function_name)) { issue('Unknown/unsupported Lambda function name'); continue; }
      const arn = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${values.function_name}`;
      for (const name of ['GetFunction', 'ListTags', 'ListVersionsByFunction', 'GetFunctionCodeSigningConfig']) action(`lambda:${name}`, arn);
      // Restrict support to the inspected unqualified, unpublished local ZIP subset.
      if (values.package_type && values.package_type !== 'Zip' || values.publish || values.qualifier ||
          values.kms_key_arn || values.source_kms_key_arn || values.s3_bucket || values.image_uri ||
          ['layers', 'vpc_config', 'file_system_config', 'dead_letter_config', 'durable_config', 'capacity_provider_config', 'tenancy_config', 'snap_start'].some(key => values[key]?.length) ||
          values.code_signing_config_arn || typeof values.reserved_concurrent_executions === 'number' && values.reserved_concurrent_executions >= 0)
        issue('Advanced Lambda configuration is not mapped');
      if (create) action('lambda:CreateFunction', arn);
      if (update && ['filename', 'source_code_hash', 'code_sha256', 'architectures'].some(field => changed(change, field)))
        action('lambda:UpdateFunctionCode', arn);
      const configUpdate = update && ['description', 'handler', 'logging_config', 'memory_size', 'role', 'timeout', 'runtime'].some(field => changed(change, field));
      if (configUpdate) action('lambda:UpdateFunctionConfiguration', arn);
      if (remove && !values.skip_destroy) action('lambda:DeleteFunction', arn);
      if (create || update && changed(change, 'role')) {
        const executionRole = resolveRole(resource, phase, resources, configuration, bindings);
        if (!executionRole) issue('Unknown Lambda execution-role ARN');
        else action('iam:PassRole', executionRole, [{ ContextKeyName: 'iam:PassedToService', ContextKeyValues: ['lambda.amazonaws.com'], ContextKeyType: 'string' }]);
      }
      tags('lambda', arn);
    }
  }
}

export function requiredPermissions(plan, backendState, { sources = [] } = {}) {
  if (!plan || !/^1\./.test(plan.format_version ?? '') || !Array.isArray(plan.resource_changes))
    throw new Error('Missing/unsupported Terraform plan JSON');
  const issues = [], requirements = new Map(), noAwsPermissions = [], inspections = [];
  const configured = configuredResources(plan.configuration?.root_module);
  const configuration = new Map(configured.map(resource => [resource.address, resource]));
  const bindings = directRoleBindings(sources);
  if (plan.errored || plan.complete === false || plan.deferred_changes?.length)
    issues.push('Plan is incomplete, errored, or contains deferred changes');
  const add = (action, resource, reason, context = []) => {
    const key = `${action}|${resource}|${JSON.stringify(context)}`;
    if (!requirements.has(key)) requirements.set(key, { action, resource, reasons: [], context });
    requirements.get(key).reasons.push(reason);
  };
  for (const resource of configured) {
    const spec = Object.hasOwn(specs, resource.type) ? specs[resource.type] : null;
    if (!spec || resource.mode !== (spec.mode ?? 'managed')) {
      issues.push(`Unsupported resource/data source: ${resource.address}`); continue;
    }
    for (const attribute of Object.keys(resource.expressions ?? {}))
      if (!spec.attributes.includes(attribute)) issues.push(`Unmapped configuration: ${resource.address}.${attribute}`);
    if (spec.local) {
      const provider = plan.configuration?.provider_config?.[resource.provider_config_key ?? 'archive'];
      if (provider?.full_name !== ARCHIVE) issues.push(`Unmapped local provider: ${resource.address}`);
      else noAwsPermissions.push(resource.address);
    }
  }
  const providers = Object.values(plan.configuration?.provider_config ?? {});
  if (!providers.length) issues.push('Missing provider configuration');
  for (const provider of providers) {
    if (provider.full_name === ARCHIVE && !provider.alias && !Object.keys(provider.expressions ?? {}).length) continue;
    if (provider.full_name !== PROVIDER || provider.alias ||
        provider.expressions?.region?.constant_value !== REGION ||
        Object.keys(provider.expressions ?? {}).some(key => key !== 'region'))
      issues.push('Only the default AWS provider in eu-west-1, without additional settings, is mapped');
  }
  for (const resource of plan.resource_changes) {
    const spec = Object.hasOwn(specs, resource.type) ? specs[resource.type] : null;
    if (!spec || resource.mode !== (spec.mode ?? 'managed') || resource.provider_name !== (spec.provider ?? PROVIDER)) {
      issues.push(`Unmapped plan resource: ${resource.address}`); continue;
    }
    if (resource.previous_address || resource.change?.importing)
      issues.push(`Move/import is not mapped: ${resource.address}`);
    const change = resource.change;
    if (!change || !Array.isArray(change.actions) ||
        change.actions.some(action => !(spec.local ? ['read', 'no-op'] : ['create', 'update', 'delete', 'no-op']).includes(action))) {
      issues.push(`Unmapped plan action: ${resource.address}`); continue;
    }
    if (spec.local) {
      noAwsPermissions.push(resource.address);
      continue;
    }
    if (spec.extended) {
      mapExtended(resource, configuration, plan.resource_changes, bindings, add, issues, inspections);
      continue;
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
    `${a.action}|${a.resource}|${JSON.stringify(a.context)}`.localeCompare(`${b.action}|${b.resource}|${JSON.stringify(b.context)}`)),
    issues: [...new Set(issues)], noAwsPermissions: [...new Set(noAwsPermissions)].sort(), inspections };
}

// These are the only AWS API calls the helper can make. None mutate AWS resources.
function aws(service, operation, request) {
  const allowed = ['iam:simulate-principal-policy', 'iam:list-instance-profiles-for-role',
    's3api:get-bucket-policy', 's3api:get-bucket-encryption'];
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
    context.push(...(requirement.context ?? []));
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
    const denied = evaluation?.PermissionsBoundaryDecisionDetail?.AllowedByPermissionsBoundary === false ||
      evaluation?.OrganizationsDecisionDetail?.AllowedByOrganizations === false ||
      [evaluation?.EvalDecision, ...(evaluation?.ResourceSpecificResults ?? []).map(item => item.EvalResourceDecision)]
        .some(value => value === 'implicitDeny' || value === 'explicitDeny');
    results.push({ ...requirement, allowed, decision,
      outcome: allowed ? 'allowed' : contextMissing.length ||
        (evaluation?.ResourceSpecificResults ?? []).some(item => item.MissingContextValues?.length)
        ? 'unverified' : denied ? 'denied' : 'unverified' });
  }
  return results;
}

const safe = text => String(text).replace(/[\r\n|<>`]/g, ' ').replace(/@/g, '@\u200b');
export function s3Buckets(requirements) {
  return [...new Set(requirements.filter(item => item.action.startsWith('s3:') && item.resource.startsWith('arn:aws:s3:::'))
    .map(item => item.resource.split(':::')[1].split('/')[0]))];
}

export async function verifyRoleProfiles(inspections, call = aws) {
  const issues = [];
  for (const inspection of inspections) {
    const profiles = await call('iam', 'list-instance-profiles-for-role', { RoleName: inspection.roleName });
    if (!Array.isArray(profiles.InstanceProfiles) || profiles.IsTruncated || profiles.InstanceProfiles.length)
      issues.push(`Cannot verify instance-profile cleanup for ${inspection.address}; only roles without instance profiles are mapped`);
  }
  return issues;
}

export function report(results, issues, noAwsPermissions = []) {
  const missing = [...new Set(results.filter(item => !item.allowed).map(item => item.action))];
  return ['## Terraform deployment permissions', '', `Deployment role: ${ROLE}`, '',
    'IAM simulation preflight only; not a guarantee of successful deployment. No AWS resources were changed.', '',
    '| Required IAM action | Resource | Available in simulation | Decision |',
    '| --- | --- | --- | --- |',
    ...results.map(item => `| ${safe(item.action)} | ${safe(item.resource)} | ${item.allowed ? 'Yes' : 'No'} | ${safe(item.decision)} |`), '',
    `Missing or unverified actions: ${missing.length ? missing.join(', ') : 'none'}`, '',
    ...noAwsPermissions.map(address => `- ${safe(address)}: supported local archive data source; no AWS IAM actions required.`), '',
    ...issues.map(issue => `- Cannot verify: ${safe(issue)}`), '',
    missing.length || issues.length ? '**FAIL: missing permissions or incomplete verification.**'
      : '**PASS: all mapped action/resource pairs are allowed by IAM simulation.**', '',
    'Resource policies on roles, RCPs, endpoint policies, deployment-session restrictions, and future policy changes may differ from simulation.', '',
    ...failureSummary(results, issues)
  ].join('\n');
}

function failedPairs(results) {
  const pairs = new Map();
  for (const item of results.filter(item => !item.allowed)) {
    const key = JSON.stringify([item.action, item.resource]);
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(item);
  }
  return [...pairs.values()];
}
const isDenied = item => item.outcome === 'denied' || (!item.outcome &&
  ['implicitDeny', 'explicitDeny', 'permissions boundary deny', 'Organizations deny'].includes(item.decision));
const annotationText = text => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function failureAnnotations(results, issues) {
  return [ ...failedPairs(results).map(items => {
    const item = items[0];
    const status = items.some(isDenied) ? 'Denied' : 'Unverified';
    return `::error::${annotationText(`${status} deployer permission: ${item.action} on ${item.resource}`)}`;
  }), ...new Set(issues.map(issue => `::error::${annotationText(`Cannot verify deployer permissions: ${issue}`)}`)) ];
}

export function failureSummary(results, issues) {
  const pairs = failedPairs(results);
  if (!pairs.length && !issues.length) return [];
  const denied = pairs.filter(items => items.some(isDenied));
  const unverified = pairs.filter(items => items.some(item => !isDenied(item)));
  const lines = ['### Final failure summary', '', 'Denied IAM actions and resource scopes:',
    ...(denied.length ? denied.map(([item]) => `- ${safe(item.action)} → ${safe(item.resource)}`) : ['- none']), '',
    'Unresolved / unverified (not confirmed missing permissions):',
    ...unverified.map(([item]) => `- ${safe(item.action)} → ${safe(item.resource)} (${safe(item.decision)})`),
    ...[...new Set(issues)].map(issue => `- ${safe(issue)}`),
    ...(!unverified.length && !issues.length ? ['- none'] : []), '', '**Suggested IAM policy**', '',
    `For ${ROLE}; confirmed denials only. Review before adding; nothing is applied automatically.`,
    'An Allow statement cannot override an explicit deny, permissions boundary, or Organizations restriction.', ''];
  const statements = new Map();
  for (const items of denied) {
    const item = items.find(isDenied);
    // Retain mapped dependent-action conditions; never invent scope for unknowns.
    const variants = [...new Map(items.filter(isDenied).map(result =>
      [JSON.stringify(result.context ?? []), result.context ?? []])).values()];
    if (variants.length > 1 && (variants.some(context => context.length !== 1) ||
        new Set(variants.map(context => context[0].ContextKeyName)).size !== 1)) {
      lines.push(`No policy suggested for ${safe(item.action)} on ${safe(item.resource)}: differing condition contexts require manual review.`);
      continue;
    }
    const context = variants.length === 1 ? variants[0] : [{ ...variants[0][0],
      ContextKeyValues: [...new Set(variants.flatMap(context => context[0].ContextKeyValues))] }];
    if (variants.flat().some(entry => entry.ContextKeyType !== 'string')) {
      lines.push(`No policy suggested for ${safe(item.action)} on ${safe(item.resource)}: unsupported condition context.`);
      continue;
    }
    const statement = { Effect: 'Allow', Action: [item.action], Resource: [item.resource],
      ...(context.length ? { Condition: { StringEquals: Object.fromEntries(context.map(entry =>
        [entry.ContextKeyName, entry.ContextKeyValues])) } } : {}) };
    statements.set(JSON.stringify(statement), statement);
  }
  if (statements.size) lines.push('```json', JSON.stringify({ Version: '2012-10-17', Statement: [...statements.values()] }, null, 2), '```');
  else lines.push('No policy suggested: no confirmed denied permissions with supported scope/conditions. Resolve verification failures first.');
  return [...lines, ''];
}

export async function main() {
  if (process.env.DEPLOYER_ROLE_ARN !== ROLE) throw new Error('Unexpected deployment role');
  if (process.env.TF_WORKSPACE && process.env.TF_WORKSPACE !== 'default') throw new Error('Only default workspace is mapped');
  const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const backend = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const sources = readdirSync('.').filter(name => name.endsWith('.tf')).map(name => readFileSync(name, 'utf8'));
  const { requirements, issues, noAwsPermissions, inspections } = requiredPermissions(plan, backend, { sources });
  let results = requirements.map(item => ({ ...item, allowed: false, decision: 'not evaluated' }));
  try {
    results = await simulate(requirements);
    // IAM cannot simulate resource-based policies for roles. Refuse to certify
    // buckets with such policies, including the backend, instead of ignoring them.
    for (const bucket of s3Buckets(requirements)) {
      try {
        const policy = aws('s3api', 'get-bucket-policy', { Bucket: bucket, ExpectedBucketOwner: ACCOUNT });
        if (policy.Policy) issues.push(`Bucket policy on ${bucket} cannot be simulated for an IAM role`);
      } catch (error) {
        if (!['NoSuchBucketPolicy', 'NoSuchBucket'].includes(error.code)) throw error;
      }
    }
    issues.push(...await verifyRoleProfiles(inspections));
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
  const summary = report(results, issues, noAwsPermissions);
  for (const annotation of failureAnnotations(results, issues)) console.error(annotation);
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
