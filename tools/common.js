/**
 * Shared schema fragments and renderers for the tool definitions.
 *
 * Every result schema here is deliberately *permissive*: no required fields. A failure value is
 * `{ok:false, code, message, hint}`, and an output schema that demanded `path`/`bytes` would reject it
 * before the renderer could turn it into the self-explanatory text the brief asks for.
 */
import { HINTS, VmError } from '../lib/errors.js';

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
    'Virtual machine id. Omit to use `defaultVmid`, or — when that is 0 — the only running VM on the ' +
    'known hosts. When several VMs run, the call fails with AMBIGUOUS_VMID and lists them.',
};

/** Common `node` parameter: a host, not a VM's owner (that is discovered). */
export const NODE_PARAM = {
  type: 'string',
  description:
    'PVE host to talk to: an ssh alias or an address, e.g. "pve04" or "192.168.90.104". Omit to use ' +
    'the settings list or PVE_HOSTS. The node that actually owns the VM is found with `qm status`, ' +
    'so this only has to be a host that can reach the cluster.',
};

/**
 * Which VM, and which host, a call works on.
 * @param {object} deps plugin wiring.
 * @param {object} args tool arguments (`vmid`, `node`).
 * @param {object} exec tool execution context.
 * @returns {Promise<{vmid:number, source:string, host:string, node:string|null,
 *   status:string, vm:object|undefined}>} the resolved target.
 */
export async function target(deps, args, exec) {
  const signal = exec?.signal;
  const picked = await deps.registry.pickVmid(args.vmid, { host: args.node, signal });
  const resolved = await deps.registry.resolve(picked.vmid, { host: args.node, signal });
  return {
    vmid: picked.vmid,
    source: picked.source,
    host: resolved.host,
    node: resolved.node,
    status: resolved.status,
    vm: picked.vm,
  };
}

/**
 * A host to ssh to when the call is not about one VM (task lists, storage content).
 *
 * The cluster snapshot already carries the host that answered, so this reuses it instead of
 * guessing: `seed.host` is an address that provably works right now.
 * @param {object} deps plugin wiring.
 * @param {object} args tool arguments (`node`).
 * @param {object} exec tool execution context.
 * @returns {Promise<{host:string, node:string|null, cluster:string|null}>} the seed host.
 */
export async function seedHost(deps, args, exec) {
  const signal = exec?.signal;
  const snapshot = await deps.registry.clusterView({ host: args.node, signal });
  if (snapshot?.seed?.host) {
    return { host: snapshot.seed.host, node: snapshot.seed.node ?? null, cluster: snapshot.cluster?.name ?? null };
  }
  const view = await deps.registry.listVms({ host: args.node, signal });
  const entry = (view?.hosts ?? []).find((candidate) => typeof candidate?.host === 'string' && candidate.host.length > 0);
  if (!entry) {
    throw new VmError('NODE_NOT_CONFIGURED', 'no PVE host answered, and the call did not name one', {
      hint: 'Pass node:"pve04" (an ssh alias or an address), set the settings `hosts` list, or export PVE_HOSTS.',
    });
  }
  return { host: entry.host, node: entry.node ?? null, cluster: view?.cluster?.name ?? null };
}

/** Format a duration for a human. */
export function seconds(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
