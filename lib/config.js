/**
 * Plugin configuration — the settings form is built by the `settings` service from this schema.
 *
 * Every field is `.volatile()`: without it the service refuses to write the value back
 * ("Config field … is not volatile") and `apply` receives live references with `.get()`.
 *
 * Security defaults are deliberately closed: no node is reachable and no VM id is allowed
 * until the operator fills both lists. The `cordis.patch.yml` shipped in this package pins
 * the reference deployment (the jev test VM) — see docs/DETAIL.md.
 */
import z from '@deepseek-ai/schemastery';

/** Keys read by {@link snapshot}; keep in sync with {@link Config}. */
export const CONFIG_KEYS = [
  'nodes',
  'sshUser',
  'sshPort',
  'sshKeyPath',
  'sshConfigFile',
  'sshExtraOptions',
  'connectTimeoutMs',
  'defaultVmid',
  'allowedVmids',
  'tmpfsDir',
  'localOutDir',
  'allowGuestExec',
  'guestTimeoutMs',
  'qmpTimeoutMs',
  'burstMaxSeconds',
  'maxGuestOutputBytes',
  'frameFormat',
  'frameQuality',
  'auditLog',
];

export const Config = z.object({
  nodes: z
    .array(z.string())
    .default([])
    .description(
      'Proxmox VE node addresses this plugin may reach over ssh (for example 192.168.90.104). ' +
        'The node that owns a VM is discovered with `qm status`, never guessed. ' +
        'An empty list forbids every node.',
    )
    .volatile(),
  sshUser: z.string().default('root').description('ssh user on the node.').volatile(),
  sshPort: z.number().step(1).min(1).max(65535).default(22).description('ssh port.').volatile(),
  sshKeyPath: z
    .string()
    .default('')
    .description('Path to the private SSH key. Empty — the default SSH keys.')
    .volatile(),
  sshConfigFile: z
    .string()
    .default('/dev/null')
    .description(
      'Value for `ssh -F`. Default /dev/null: the host ssh_config is bypassed, which also ' +
        'sidesteps its permissions being broken. Empty — the standard ~/.ssh/config.',
    )
    .volatile(),
  sshExtraOptions: z
    .array(z.string())
    .default([])
    .description('Extra `ssh -o` options, one per element.')
    .volatile(),
  connectTimeoutMs: z
    .number()
    .step(500)
    .min(1000)
    .default(8000)
    .description('ssh ConnectTimeout, ms. Without the VPN a call fails here, not in the plugin.')
    .volatile(),
  defaultVmid: z
    .number()
    .step(1)
    .min(1)
    .default(0)
    .description('VM used when a tool call omits `vmid`. 0 — no default, `vmid` is required.')
    .volatile(),
  allowedVmids: z
    .array(z.number().step(1).min(1))
    .default([])
    .description('VMs these tools may touch. An empty list denies every VM id.')
    .volatile(),
  tmpfsDir: z
    .string()
    .default('/dev/shm/pve-rec')
    .description(
      'Directory on the node for transient frames (`<tmpfsDir>/v<vmid>/…`). ' +
        'Absolute path, characters [A-Za-z0-9._/-] only.',
    )
    .volatile(),
  localOutDir: z
    .string()
    .default('pve-rec')
    .description(
      'Where screenshots and frames are written on this machine. A relative path resolves ' +
        'against the session working directory (so the agent can open the files).',
    )
    .volatile(),
  allowGuestExec: z
    .boolean()
    .default(false)
    .description(
      'Expose `pve_guest_exec` — arbitrary PowerShell as SYSTEM through the guest agent. ' +
        'Off by default: every call is written to the audit log when enabled.',
    )
    .volatile(),
  guestTimeoutMs: z
    .number()
    .step(1000)
    .min(5000)
    .default(120000)
    .description('How long the guest may run one command, ms (maps to `qm guest exec --timeout`).')
    .volatile(),
  qmpTimeoutMs: z
    .number()
    .step(500)
    .min(1000)
    .default(3000)
    .description(
      'Timeout of one QMP connection, ms. The QMP socket accepts a single client, so a busy ' +
        'socket shows up here and is reported as QMP_BUSY instead of being waited out.',
    )
    .volatile(),
  burstMaxSeconds: z
    .number()
    .step(1)
    .min(1)
    .max(3600)
    .default(60)
    .description('Hard cap on one burst duration, seconds: the remote loop always stops by itself.')
    .volatile(),
  maxGuestOutputBytes: z
    .number()
    .step(1)
    .min(1024)
    .max(65536)
    .default(8192)
    .description('Guest output kept in a tool result, bytes; the rest is cut and flagged.')
    .volatile(),
  frameFormat: z
    .union(['jpeg', 'png'])
    .default('jpeg')
    .description(
      'Format of saved frames. jpeg needs ffmpeg/ImageMagick here; without them frames are ' +
        'written as png (the built-in encoder always works).',
    )
    .volatile(),
  frameQuality: z
    .number()
    .step(1)
    .min(1)
    .max(31)
    .default(4)
    .description('Quality of saved frames: ffmpeg -q:v value, lower is better (2…6 is sensible).')
    .volatile(),
  auditLog: z
    .string()
    .default('')
    .description(
      'Audit log for `pve_guest_exec` (rolling, 2 files). Empty — `<localOutDir>/audit.jsonl`.',
    )
    .volatile(),
});

/**
 * Read the live settings into a plain object.
 * @param {Record<string, {get?: () => unknown}>} live the config object `apply` received.
 * @returns {Record<string, unknown>} a slice of the settings at call time.
 */
export function snapshot(live) {
  const section = {};
  for (const key of CONFIG_KEYS) {
    const field = live?.[key];
    const value = typeof field?.get === 'function' ? field.get() : field;
    if (value !== undefined) section[key] = value;
  }
  return section;
}

/** Paths are interpolated into remote shell scripts, so the charset is restricted. */
const PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;

/**
 * Local paths are never interpolated into a remote shell, so they only have to be a sane path:
 * absolute (or relative without `..`) and free of control characters. Workspace directories with
 * non-ASCII names are common and must work — the remote-only PATH_PATTERN above is stricter on
 * purpose, because that string ends up inside a bash script.
 */
const CONTROL_CHARS = /[\u0000-\u001f]/;

/**
 * Is this a usable local output directory?
 * @param {string} value configured value.
 * @returns {boolean} whether it may be used as is.
 */
function isLocalPath(value) {
  if (value.length === 0 || CONTROL_CHARS.test(value)) return false;
  if (value.startsWith('/')) return true;
  return !value.split('/').includes('..');
}

/** Expand a leading `~`. */
function expandHome(path) {
  if (typeof path !== 'string' || path.length === 0) return '';
  if (path === '~') return process.env.HOME ?? path;
  if (path.startsWith('~/')) return `${process.env.HOME ?? '~'}${path.slice(1)}`;
  return path;
}

/**
 * Reduce the settings slice to a shape the tools use.
 * @param {Record<string, unknown>} section the result of {@link snapshot}.
 * @returns {object} resolved settings; invalid paths fall back to the default.
 */
export function resolveSettings(section) {
  const nodes = (Array.isArray(section.nodes) ? section.nodes : [])
    .map((value) => String(value ?? '').trim())
    .filter((value) => /^[A-Za-z0-9.-]+$/.test(value));
  const allowedVmids = (Array.isArray(section.allowedVmids) ? section.allowedVmids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  const tmpfs = String(section.tmpfsDir ?? '');
  const tmpfsDir = PATH_PATTERN.test(tmpfs) ? tmpfs.replace(/\/+$/, '') : '/dev/shm/pve-rec';
  const local = String(section.localOutDir ?? '');
  const localOutDir = isLocalPath(local) ? local.replace(/\/+$/, '') || 'pve-rec' : 'pve-rec';
  const defaultVmid = Number(section.defaultVmid ?? 0);
  return {
    ssh: {
      nodes,
      user: String(section.sshUser ?? 'root') || 'root',
      port: Number(section.sshPort ?? 22) || 22,
      keyPath: expandHome(String(section.sshKeyPath ?? '')),
      sshConfig: expandHome(String(section.sshConfigFile ?? '/dev/null')),
      extraOptions: (Array.isArray(section.sshExtraOptions) ? section.sshExtraOptions : []).map(String),
      connectTimeoutMs: Math.max(1000, Number(section.connectTimeoutMs ?? 8000)),
    },
    defaultVmid: Number.isInteger(defaultVmid) && defaultVmid > 0 ? defaultVmid : 0,
    allowedVmids,
    tmpfsDir,
    localOutDir,
    allowGuestExec: section.allowGuestExec === true,
    guestTimeoutMs: Math.max(5000, Number(section.guestTimeoutMs ?? 120000)),
    qmpTimeoutMs: Math.max(1000, Number(section.qmpTimeoutMs ?? 3000)),
    burstMaxSeconds: clamp(Number(section.burstMaxSeconds ?? 60), 1, 3600, 60),
    maxGuestOutputBytes: clamp(Number(section.maxGuestOutputBytes ?? 8192), 1024, 65536, 8192),
    frameFormat: section.frameFormat === 'png' ? 'png' : 'jpeg',
    frameQuality: clamp(Number(section.frameQuality ?? 4), 1, 31, 4),
    auditLog: String(section.auditLog ?? ''),
  };
}

/**
 * A number inside bounds.
 * @param {number} value parsed value.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @param {number} fallback default.
 * @returns {number}
 */
function clamp(value, min, max, fallback) {
  const parsed = Math.round(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Per-VM remote directory layout on the node.
 * @param {object} settings resolved settings.
 * @param {number} vmid VM id.
 * @returns {{root:string,shots:string,burst:string}} absolute paths.
 */
export function remotePaths(settings, vmid) {
  const root = `${settings.tmpfsDir}/v${Number(vmid)}`;
  return { root, shots: `${root}/shots`, burst: `${root}/burst` };
}

/**
 * Resolve the local output directory for a tool call.
 * @param {object} settings resolved settings.
 * @param {string} cwd session working directory (absolute).
 * @param {string} [sub] optional subdirectory.
 * @returns {string} absolute local directory.
 */
export function localDir(settings, cwd, sub) {
  const base = settings.localOutDir.startsWith('/')
    ? settings.localOutDir
    : `${cwd.replace(/\/+$/, '')}/${settings.localOutDir}`;
  if (sub === undefined || sub.length === 0) return base;
  const clean = sub.replace(/^\/+/, '');
  if (clean.includes('..')) return base;
  return `${base}/${clean}`;
}
