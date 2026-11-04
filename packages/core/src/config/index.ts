import path from 'node:path';
import { sha256 } from '../hash.ts';
import { isTaskKind, TaskWeaveError } from '../types.ts';
import type { CheckDefinition, RuntimeConfig, ValidationPolicy, ValidationRule } from '../types.ts';

export const DEFAULT_VALIDATION: ValidationPolicy = { rules: [], checks: [], requireApproval: true };
const fail = (): never => { throw new TaskWeaveError('INVALID_CONFIG', '验证配置无效，请参考 docs/validation.md'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail();
}
function text(value: unknown, max = 4_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) return fail();
  return value;
}
function texts(value: unknown, max = 30): string[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  return value.map(item => text(item));
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) return fail();
  return Number(value);
}
export function configRelativePath(value: unknown, hidden = false): string {
  const file = text(value);
  if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => part === '..' || (!hidden && part.startsWith('.') && part !== '.'))) return fail();
  return file;
}

export function parseValidationPolicy(value: unknown): ValidationPolicy {
  const policy = object(value);
  keys(policy, ['rules', 'checks', 'requireApproval']);
  if (policy.requireApproval !== undefined && typeof policy.requireApproval !== 'boolean') fail();
  const rawRules = policy.rules ?? [];
  if (!Array.isArray(rawRules) || rawRules.length > 30) return fail();
  const rules: ValidationRule[] = rawRules.map(raw => {
    const rule = object(raw);
    const file = configRelativePath(rule.path);
    if (rule.type === 'exists') { keys(rule, ['type', 'path']); return { type: 'exists', path: file }; }
    if (rule.type === 'contains') { keys(rule, ['type', 'path', 'text']); return { type: 'contains', path: file, text: text(rule.text) }; }
    if (rule.type === 'json_fields') { keys(rule, ['type', 'path', 'fields']); const fields = texts(rule.fields); if (!fields.length) return fail(); return { type: 'json_fields', path: file, fields }; }
    return fail();
  });
  const checks = [...new Set(texts(policy.checks ?? []))];
  const requireApproval = policy.requireApproval !== false;
  // Hash checks alone cannot establish business correctness.
  if (!requireApproval && !rules.length && !checks.length) return fail();
  return { rules, checks, requireApproval };
}

export function parseConfig(value: unknown): RuntimeConfig {
  const config = object(value);
  keys(config, ['version', 'checks', 'validation', 'skills', 'context']);
  if (config.version !== 1) return fail();
  const checks = Object.create(null) as Record<string, CheckDefinition>;
  const definitions = object(config.checks ?? {});
  if (Object.keys(definitions).length > 30) return fail();
  for (const name of Object.keys(definitions).sort()) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) fail();
    const spec = object(definitions[name]);
    keys(spec, ['command', 'args', 'cwd', 'timeoutMs', 'maxOutputBytes']);
    const args = spec.args ?? [];
    if (!Array.isArray(args) || args.length > 100 || args.some(arg => typeof arg !== 'string' || arg.length > 8_000 || arg.includes('\0'))) fail();
    checks[name] = {
      command: text(spec.command, 1_000), args: [...args as string[]], cwd: configRelativePath(spec.cwd ?? '.'),
      timeoutMs: integer(spec.timeoutMs, 30_000, 120_000), maxOutputBytes: integer(spec.maxOutputBytes, 16_384, 65_536)
    };
  }
  const validation: RuntimeConfig['validation'] = {};
  const policies = object(config.validation ?? {});
  for (const kind of Object.keys(policies).sort()) {
    if (!isTaskKind(kind)) return fail();
    const policy = parseValidationPolicy(policies[kind]);
    if (policy.checks.some(name => !Object.hasOwn(checks, name))) return fail();
    validation[kind] = policy;
  }
  const extra: Pick<RuntimeConfig, 'skills' | 'context'> = {};
  if (config.skills !== undefined) {
    const catalog = object(config.skills);
    if (Object.keys(catalog).length > 30) fail();
    extra.skills = Object.create(null);
    for (const id of Object.keys(catalog).sort()) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail();
      const spec = object(catalog[id]); keys(spec, ['path']);
      const file = configRelativePath(spec.path);
      if (!/(^|\/)SKILL\.md$/.test(file)) fail();
      extra.skills![id] = { path: file };
    }
  }
  if (config.context !== undefined) {
    const spec = object(config.context); keys(spec, ['maxCharacters']);
    const maxCharacters = integer(spec.maxCharacters, 80_000, 200_000);
    if (maxCharacters < 4_000) fail();
    extra.context = { maxCharacters };
  }
  // Omitted v0.4 options stay omitted so existing v1 config fingerprints remain valid.
  return { version: 1, checks, validation, ...extra };
}

export function configHash(config: RuntimeConfig): string { return sha256(JSON.stringify(parseConfig(config))); }
