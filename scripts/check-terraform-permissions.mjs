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
  aws_apigatewayv2_api: {
    attributes: ['name', 'protocol_type', 'description', 'disable_execute_api_endpoint', 'region'], extended: true
  },
  aws_apigatewayv2_integration: {
    attributes: ['api_id', 'integration_type', 'integration_uri', 'integration_method', 'payload_format_version',
      'description', 'timeout_milliseconds', 'region'], extended: true
  },
  aws_apigatewayv2_route: {
    attributes: ['api_id', 'route_key', 'authorization_type', 'target', 'region'], extended: true
  },
  aws_apigatewayv2_stage: {
    attributes: ['api_id', 'name', 'auto_deploy', 'description', 'region'], extended: true
  },
  aws_lambda_permission: {
    attributes: ['statement_id', 'statement_id_prefix', 'action', 'function_name', 'principal', 'source_arn', 'region'], extended: true
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
  return directBindings(sources, /^"aws_(lambda_function|iam_role_policy)"$/, 'role', /^aws_iam_role\.[\w-]+\.(arn|id|name)$/);
}

function directApiBindings(sources) {
  return directBindings(sources, /^"aws_apigatewayv2_(integration|route|stage)"$/, 'api_id', /^aws_apigatewayv2_api\.[\w-]+\.id$/);
}

function directBindings(sources, types, field, target) {
  const bindings = new Map();
  const lexer = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|<<-?(\w+)[^\n]*\n[\s\S]*?\n[ \t]*\1(?:\r?\n|$)|"(?:\\.|[^"\\])*"|[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*|[{}=]|\n|[^\s]/g;
  for (const source of sources) {
    const tokens = [...source.matchAll(lexer)].map(match => match[0])
      .filter(token => !/^(\/\*|\/\/|#)/.test(token));
    let depth = 0, address = null;
    for (let i = 0; i < tokens.length; i++) {
      if (depth === 0 && tokens[i] === 'resource' && types.test(tokens[i + 1] ?? '') &&
          /^"[\w-]+"$/.test(tokens[i + 2] ?? '') && tokens[i + 3] === '{') {
        address = `${JSON.parse(tokens[i + 1])}.${JSON.parse(tokens[i + 2])}`;
        i += 3; depth = 1; continue;
      }
      if (tokens[i] === '{') depth++;
      else if (tokens[i] === '}') { depth--; if (depth === 0) address = null; }
      else if (address && depth === 1 && tokens[i] === field && tokens[i + 1] === '=' &&
          target.test(tokens[i + 2] ?? '') &&
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

function generatedApi(resource, configuration, resources, bindings) {
  const creatingAPI = item => item.type === 'aws_apigatewayv2_api' && item.mode === 'managed' &&
    item.provider_name === PROVIDER && item.change?.actions?.includes('create') &&
    item.change.after?.protocol_type === 'HTTP' && item.change.after?.id == null && item.change.after_unknown?.id === true;
  if (resource.type === 'aws_apigatewayv2_api') return creatingAPI(resource);
  const binding = bindings.get(resource.address);
  if (!binding || !/^aws_apigatewayv2_api\.[\w-]+\.id$/.test(binding)) return false;
  const address = binding.slice(0, -3);
  const refs = configuration.get(resource.address)?.expressions?.api_id?.references ?? [];
  const matches = resources.filter(item => item.address === address);
  return refs.includes(binding) && refs.every(ref => ref === binding || ref === address) &&
    matches.length === 1 && creatingAPI(matches[0]);
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
    if (resource.type.startsWith('aws_apigatewayv2_')) {
      // Official provider v6.67.0: internal/service/apigatewayv2/{api,integration,route,stage}.go
      // IAM verbs and ARN paths: https://docs.aws.amazon.com/service-authorization/latest/reference/list_apigatewayv2.html
      // Support the untagged HTTP API/Lambda proxy subset in infra/api.tf.
      if (Object.keys(values.tags_all ?? values.tags ?? {}).length || values.credentials_arn || values.body ||
          values.target && resource.type === 'aws_apigatewayv2_api' || values.cors_configuration?.length ||
          values.access_log_settings?.length || values.route_settings?.length || values.default_route_settings?.length ||
          values.client_certificate_id || values.stage_variables && Object.keys(values.stage_variables).length)
        issue('Advanced API Gateway configuration or tagging is not mapped');
      if (resource.type === 'aws_apigatewayv2_api' && values.protocol_type !== 'HTTP') issue('Only HTTP APIs are mapped');
      if (resource.type === 'aws_apigatewayv2_integration' && (values.integration_type !== 'AWS_PROXY' ||
          values.connection_type && values.connection_type !== 'INTERNET' || values.integration_subtype || values.connection_id ||
          values.integration_method !== 'POST' || values.payload_format_version !== '2.0'))
        issue('Only HTTP Lambda proxy integrations without a credentials role are mapped');
      if (resource.type === 'aws_apigatewayv2_route' && (values.authorization_type ?? 'NONE') !== 'NONE')
        issue('Route authorizers are not mapped');

      const base = `arn:aws:apigateway:${REGION}::/apis`;
      const isAPI = resource.type === 'aws_apigatewayv2_api';
      // AWS-generated IDs are normal on create. Use explicit ARN patterns only
      // for a proven same-plan creation; never reuse replacement IDs or guess IDs.
      let apiID = isAPI ? values.id : values.api_id;
      const validID = id => typeof id === 'string' && /^[a-z0-9]+$/.test(id);
      if (isAPI && create) action('apigateway:POST', base);
      const generated = create && apiID == null && change.after_unknown?.[isAPI ? 'id' : 'api_id'] === true &&
        generatedApi(resource, configuration, resources, bindings);
      if (!validID(apiID) && !generated) { issue(`Unverified API Gateway ID (${phase}); required GET${create ? '/POST' : update ? '/PATCH' : remove ? '/DELETE' : ''} cannot be scoped`); continue; }
      if (generated) apiID = '*';
      const apiArn = `${base}/${apiID}`;
      const collection = ({ aws_apigatewayv2_integration: 'integrations', aws_apigatewayv2_route: 'routes',
        aws_apigatewayv2_stage: 'stages' })[resource.type];
      if (!isAPI && create) action('apigateway:POST', `${apiArn}/${collection}`);
      if (resource.type === 'aws_apigatewayv2_stage') action('apigateway:GET', apiArn); // Stage refresh also calls GetApi.
      let id = resource.type === 'aws_apigatewayv2_stage' ? values.name : values.id;
      const generatedChild = !isAPI && resource.type !== 'aws_apigatewayv2_stage' && create &&
        id == null && change.after_unknown?.id === true;
      if (!isAPI && !(resource.type === 'aws_apigatewayv2_stage'
        ? typeof id === 'string' && /^(?:\$default|[\w-]{1,128})$/.test(id) : validID(id) || generatedChild)) {
        issue(`Unverified API Gateway child ID (${phase}); required GET/PATCH/DELETE cannot be scoped`); continue;
      }
      if (generatedChild) id = '*';
      const arn = isAPI ? apiArn : `${apiArn}/${collection}/${id}`;
      action('apigateway:GET', arn);
      const updateFields = isAPI ? ['name', 'description', 'disable_execute_api_endpoint']
        : resource.type === 'aws_apigatewayv2_integration'
          ? ['integration_uri', 'integration_method', 'payload_format_version', 'description', 'timeout_milliseconds']
          : resource.type === 'aws_apigatewayv2_route' ? ['route_key', 'authorization_type', 'target']
          : ['auto_deploy', 'description'];
      if (update && updateFields.some(field => changed(change, field))) action('apigateway:PATCH', arn);
      if (remove) action('apigateway:DELETE', arn);
    } else if (resource.type === 'aws_lambda_permission') {
      // Official provider v6.67.0: internal/service/lambda/permission.go (all input changes are ForceNew).
      // Exact actions/conditions: https://docs.aws.amazon.com/service-authorization/latest/reference/list_lambda.html
      const name = values.function_name;
      const arn = typeof name === 'string' && /^[\w-]{1,64}$/.test(name)
        ? `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`
        : typeof name === 'string' && new RegExp(`^arn:aws:lambda:${REGION}:${ACCOUNT}:function:[\\w-]{1,64}$`).test(name) ? name : null;
      if (!arn) { issue(`Unknown/unsupported permission function (${phase})`); continue; }
      action('lambda:GetPolicy', arn);
      if (values.qualifier || values.function_url_auth_type || values.invoked_via_function_url || values.event_source_token ||
          values.principal_org_id || values.source_account || values.action !== 'lambda:InvokeFunction' ||
          values.principal !== 'apigateway.amazonaws.com') { issue('Only unqualified API Gateway invocation permissions are mapped'); continue; }
      if (update) issue('Lambda permission updates require replacement');
      const context = [{ ContextKeyName: 'lambda:Principal', ContextKeyValues: ['apigateway.amazonaws.com'], ContextKeyType: 'string' }];
      if (create) action('lambda:AddPermission', arn, context);
      if (remove) action('lambda:RemovePermission', arn, context);
    } else if (resource.type === 'aws_cloudwatch_log_group') {
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
  const bindings = new Map([...directRoleBindings(sources), ...directApiBindings(sources)]);
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
