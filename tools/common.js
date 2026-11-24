/**
 * Shared schema fragments and renderers for the tool definitions.
 *
 * Every result schema here is deliberately *permissive*: no required fields. A failure value is
 * `{ok:false, code, message, hint}`, and an output schema that demanded `path`/`bytes` would reject it
 * before the renderer could turn it into the self-explanatory text the brief asks for.
 */
import { HINTS } from '../lib/errors.js';

/** The failure part shared by every tool's output schema. */
export const FAILURE_PROPS = {
  ok: { type: 'boolean', description: 'False when the call failed; the failure is described by code and hint.' },
  code: { type: 'string', description: 'Stable error code (see the error table in docs/DETAIL.md).' },
  message: { type: 'string', description: 'What went wrong, as seen by the plugin.' },
  hint: { type: 'string', description: 'What to do about it.' },
  ms: { type: 'number', description: 'Wall time of the call, milliseconds.' },
  details: {
    type: 'object',
    properties: {},
    additionalProperties: true,
    description: 'Failure diagnostics: frame counts, timings or paths that explain the failure.',
  },
};

/**
 * The object every tool returns: always `ok`, plus the tool-specific fields.
 * @param {object} props tool-specific properties.
 * @param {string[]} [required] names that must be present.
 * @returns {object} a JSON schema node.
 */
export function schema(props) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { ...props, ...FAILURE_PROPS },
  };
}

/**
 * Text for a failure value.
 * @param {object} value the canonical failure.
 * @returns {string} one readable block.
 */
export function failureText(value) {
  const code = value.code ?? 'INTERNAL';
  const hint = value.hint ?? HINTS[code] ?? 'Read the message above; the failure is not covered by a hint yet.';
  const head = `FAILED ${code}${value.message ? `: ${value.message}` : ''}`;
  const details = value.details === undefined ? '' : `\ndetails: ${JSON.stringify(value.details)}`;
  return `${head}\n${hint}${details}`;
}

/**
 * Render as one text block, handling the failure shape first.
 * @param {string} okText text for a successful value.
 * @param {(value:object)=>string} [detail] extra lines for a successful value.
 * @returns {(args:object, value:object)=>object[]} a renderer.
 */
export function textRender(okText, detail) {
  return (_args, value) => {
    if (value && value.ok === false) return [{ type: 'text', text: failureText(value) }];
    const extra = detail ? detail(value) : '';
    return [{ type: 'text', text: `${okText}\n${extra}`.trimEnd() }];
  };
}

/**
 * The session working directory, or the process directory when the session is unknown.
 * @param {object|undefined} exec tool execution context.
 * @param {object} ctx the plugin context.
 * @returns {string} absolute path.
 */
export function sessionCwd(exec, ctx) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;
    const session = exec?.agent?.session;
    if (service !== undefined && service !== null && session !== undefined) {
      const directory = service.get(session);
      if (typeof directory === 'string' && directory.length > 0) return directory;
    }
  } catch {
    // The service is optional: fall through to the process directory.
  }
  return process.cwd();
}

/** Common `vmid` parameter description. */
export const VMID_PARAM = {
  type: 'number',
  description:
    'Virtual machine id. Must be listed in the plugin setting `allowedVmids`; omit to use `defaultVmid`. ' +
    'The node that hosts the VM is discovered at run time — never pass a node name here.',
};

/** Format a duration for a human. */
export function seconds(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
