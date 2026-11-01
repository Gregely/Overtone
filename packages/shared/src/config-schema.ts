/**
 * Declarative provider configuration schema.
 *
 * Each provider manifest declares its settings as a flat list of typed fields.
 * The server validates submitted config with {@link validateConfig}; the client
 * renders the Settings > Sources form from the same schema. Keeping it flat and
 * declarative (rather than full JSON Schema) makes both sides trivial.
 *
 * Secret handling rules (enforced by the server, relied upon by the client):
 *  - `secret` fields are encrypted at rest and NEVER returned by the API.
 *    The client only learns whether a secret is set ({@link PublicSourceConfig.secretsSet}).
 *  - On update, an omitted or empty-string secret means "keep the existing value";
 *    `null` means "clear it".
 *  - `hidden` fields are provider-managed (e.g. rotated OAuth tokens) and never shown.
 */

export type ConfigFieldType = 'string' | 'url' | 'path' | 'number' | 'boolean' | 'select' | 'secret';

interface BaseField {
  /** Key in the config object. `[a-zA-Z][a-zA-Z0-9_]*`. */
  key: string;
  label: string;
  /** Short help text shown under the input. */
  help?: string;
  required?: boolean;
  /** Provider-managed value, not shown in or settable from the UI. */
  hidden?: boolean;
}

export interface TextField extends BaseField {
  type: 'string' | 'url' | 'path';
  default?: string;
  placeholder?: string;
  /** Optional regex (source string) the value must match. */
  pattern?: string;
}

export interface SecretField extends BaseField {
  type: 'secret';
  placeholder?: string;
}

export interface NumberField extends BaseField {
  type: 'number';
  default?: number;
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface BooleanField extends BaseField {
  type: 'boolean';
  default?: boolean;
}

export interface SelectField extends BaseField {
  type: 'select';
  options: ReadonlyArray<{ value: string; label: string }>;
  default?: string;
}

export type ConfigField = TextField | SecretField | NumberField | BooleanField | SelectField;

/**
 * Optional "Log in with <service>" (OAuth device / PIN flow). Any provider can
 * declare it; the UI renders a button, shows the user code + verification
 * link, polls, and on success the server stores the resulting credentials
 * into `replaces` secret fields (credentials never reach the client).
 */
export interface DeviceLoginSpec {
  /** Button text, e.g. "Log in with Real-Debrid". */
  label: string;
  help?: string;
  /** Secret field keys a completed login overwrites (everything else is cleared). */
  replaces: ReadonlyArray<string>;
}

export interface ConfigSchema {
  fields: ReadonlyArray<ConfigField>;
  deviceLogin?: DeviceLoginSpec;
}

export type ConfigValue = string | number | boolean;
export type ConfigValues = Record<string, ConfigValue>;

/** What the API returns for a source's config: secrets stripped, presence flagged. */
export interface PublicSourceConfig {
  values: ConfigValues;
  /** Keys of secret fields that currently have a stored value. */
  secretsSet: string[];
  /** Credentials came from a "Log in with…" flow (stored in hidden fields). */
  signedInWithDeviceLogin?: boolean;
}

export type ValidationResult =
  | { ok: true; values: ConfigValues; secrets: Record<string, string>; clearedSecrets: string[] }
  | { ok: false; errors: Record<string, string> };

export interface ValidateOptions {
  /** Secret keys that already have a stored value (so "required" is satisfied by keeping it). */
  existingSecrets?: ReadonlySet<string> | ReadonlyArray<string>;
  /** Allow writing `hidden` fields (server-internal use, e.g. storing rotated tokens). */
  allowHidden?: boolean;
}

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const MAX_STRING = 4096;

/** Throws if a schema itself is malformed. Called when a plugin is registered. */
export function assertValidSchema(schema: ConfigSchema, owner = 'schema'): void {
  const seen = new Set<string>();
  for (const k of schema.deviceLogin?.replaces ?? []) {
    const f = schema.fields.find((x) => x.key === k);
    if (!f || f.type !== 'secret') throw new Error(`${owner}: deviceLogin.replaces "${k}" must be a secret field`);
  }
  for (const f of schema.fields) {
    if (!KEY_RE.test(f.key)) throw new Error(`${owner}: invalid field key "${f.key}"`);
    if (seen.has(f.key)) throw new Error(`${owner}: duplicate field key "${f.key}"`);
    seen.add(f.key);
    if (f.type === 'select') {
      if (f.options.length === 0) throw new Error(`${owner}: select "${f.key}" has no options`);
      if (f.default !== undefined && !f.options.some((o) => o.value === f.default)) {
        throw new Error(`${owner}: select "${f.key}" default is not an option`);
      }
    }
  }
}

/**
 * Validate and normalize user-submitted config against a schema.
 *
 * - Unknown keys are rejected (prevents smuggling values past the schema).
 * - Defaults are applied for missing non-secret fields.
 * - Numbers/booleans submitted as strings (HTML forms) are coerced.
 * - Secrets are returned separately so the caller can encrypt them.
 */
export function validateConfig(
  schema: ConfigSchema,
  input: Record<string, unknown>,
  opts: ValidateOptions = {},
): ValidationResult {
  const errors: Record<string, string> = {};
  const values: ConfigValues = {};
  const secrets: Record<string, string> = {};
  const clearedSecrets: string[] = [];
  const existing = new Set(opts.existingSecrets ?? []);
  const fieldsByKey = new Map(schema.fields.map((f) => [f.key, f]));

  for (const key of Object.keys(input)) {
    const field = fieldsByKey.get(key);
    if (!field) errors[key] = 'Unknown field';
    else if (field.hidden && !opts.allowHidden) errors[key] = 'Field is not settable';
  }

  for (const field of schema.fields) {
    if (field.hidden && !opts.allowHidden) continue;
    const raw = input[field.key];

    if (field.type === 'secret') {
      if (raw === null) {
        if (field.required) errors[field.key] = 'Required';
        else clearedSecrets.push(field.key);
        continue;
      }
      if (raw === undefined || raw === '') {
        if (field.required && !existing.has(field.key)) errors[field.key] = 'Required';
        continue;
      }
      if (typeof raw !== 'string') {
        errors[field.key] = 'Must be a string';
        continue;
      }
      if (raw.length > MAX_STRING) {
        errors[field.key] = 'Too long';
        continue;
      }
      secrets[field.key] = raw.trim();
      continue;
    }

    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (field.default !== undefined) values[field.key] = field.default;
      else if (field.required) errors[field.key] = 'Required';
      continue;
    }

    const result = coerceField(field, raw);
    if (typeof result === 'object' && result !== null && 'error' in result) errors[field.key] = result.error;
    else values[field.key] = result as ConfigValue;
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values, secrets, clearedSecrets };
}

function coerceField(field: Exclude<ConfigField, SecretField>, raw: unknown): ConfigValue | { error: string } {
  switch (field.type) {
    case 'string':
    case 'path':
    case 'url': {
      if (typeof raw !== 'string') return { error: 'Must be a string' };
      const v = raw.trim();
      if (v.length > MAX_STRING) return { error: 'Too long' };
      if (field.type === 'url' && !isHttpUrl(v)) return { error: 'Must be an http(s) URL' };
      if (field.pattern && !new RegExp(field.pattern).test(v)) return { error: 'Invalid format' };
      return v;
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
      if (!Number.isFinite(n)) return { error: 'Must be a number' };
      if (field.integer && !Number.isInteger(n)) return { error: 'Must be a whole number' };
      if (field.min !== undefined && n < field.min) return { error: `Must be ≥ ${field.min}` };
      if (field.max !== undefined && n > field.max) return { error: `Must be ≤ ${field.max}` };
      return n;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'on' || raw === '1') return true;
      if (raw === 'false' || raw === 'off' || raw === '0') return false;
      return { error: 'Must be true or false' };
    }
    case 'select': {
      if (typeof raw !== 'string' || !field.options.some((o) => o.value === raw)) return { error: 'Not a valid option' };
      return raw;
    }
  }
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Remove secret and hidden values from a config before it leaves the server. */
export function toPublicConfig(
  schema: ConfigSchema,
  values: ConfigValues,
  storedSecretKeys: Iterable<string>,
): PublicSourceConfig {
  const visible = new Set(schema.fields.filter((f) => f.type !== 'secret' && !f.hidden).map((f) => f.key));
  const secretKeys = new Set(schema.fields.filter((f) => f.type === 'secret' && !f.hidden).map((f) => f.key));
  const out: ConfigValues = {};
  for (const [k, v] of Object.entries(values)) if (visible.has(k)) out[k] = v;
  return { values: out, secretsSet: [...storedSecretKeys].filter((k) => secretKeys.has(k)) };
}
