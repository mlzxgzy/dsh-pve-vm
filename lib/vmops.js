/**
 * Builders for the "everything except pixels" half of the PVE API: power, config, snapshots,
 * migration, cloning, host-level keys, tasks and storage content.
 *
 * The same rules as the rest of the plugin hold here: the guest-side value never reaches a shell
 * unvalidated, every remote script goes over `ssh ... bash -s` on stdin, and the output is a small
 * canonical object rather than whatever the node happened to print.
 *
 * `qm <cmd> --help` does not exist on PVE 7 (it answers "Unknown option: help"), so the option
 * names below were taken from the shipped `man qm` of pve-manager 7.4-20 and from `qm list` /
 * `pvesh` behaviour observed on a real node.
 */

import { VmError } from './errors.js';

const VMID_RE = /^[1-9][0-9]{0,8}$/;
const SNAP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STORAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/;
const UPID_RE = /^UPID:([A-Za-z0-9][A-Za-z0-9.-]{0,63}):[A-Za-z0-9]{1,64}:[0-9A-Fa-f]+:[0-9A-Fa-f]+:([A-Za-z0-9_.-]{1,40}):([A-Za-z0-9@.-]{1,64}):([A-Za-z0-9@.-]{1,64}):$/;

/** A numeric vmid, or a VmError. Nothing else is ever interpolated into a command line. */
export function vmidArg(vmid) {
  const text = String(vmid ?? '').trim();
  if (!VMID_RE.test(text)) throw new VmError('BAD_VMID', `"${text}" is not a valid VM id`, { vmid: text });
  return text;
}

/** A snapshot name accepted by `qm snapshot` (letters, digits, dot, dash, underscore). */
export function snapshotArg(name) {
  const text = String(name ?? '').trim();
  if (!SNAP_RE.test(text)) {
    throw new VmError('BAD_ARGS', `"${text}" is not a usable snapshot name`, {
      pattern: SNAP_RE.source,
    });
  }
  return text;
}

/** A storage id such as `local-lvm` or `vm-b`. */
export function storageArg(name) {
  const text = String(name ?? '').trim();
  if (!STORAGE_RE.test(text)) {
    throw new VmError('BAD_ARGS', `"${text}" is not a usable storage id`, { pattern: STORAGE_RE.source });
  }
  return text;
}

/** A cluster node name such as `pve04`. */
export function nodeArg(name) {
  const text = String(name ?? '').trim();
  if (!NODE_RE.test(text)) {
    throw new VmError('BAD_ARGS', `"${text}" is not a usable node name`, { pattern: NODE_RE.source });
  }
  return text;
}

/** A PVE task id. Returns its node, type and vmid, which is how every reply is correlated. */
export function parseUpid(upid) {
  const text = String(upid ?? '').trim();
  const match = UPID_RE.exec(text);
  if (!match) throw new VmError('BAD_ARGS', `"${text}" is not a PVE task id (UPID:...)`, { upid: text });
  return { upid: text, node: match[1], type: match[2], vmid: match[3] };
}

const bool = (value) => (value === true || value === 'true' || value === 1 || value === '1' ? '1' : '0');

/** `qm start <vmid>` */
export function startScript(vmid) {
  return `qm start ${vmidArg(vmid)} 2>&1; echo "rc=$?"`;
}

/** `qm stop <vmid>` — hard power off, the VM does not get to flush anything. */
export function stopScript(vmid, options = {}) {
  const args = [];
  if (Number.isFinite(Number(options.timeout))) args.push(`--timeout ${Math.max(0, Math.trunc(Number(options.timeout)))}`);
  return `qm stop ${vmidArg(vmid)} ${args.join(' ')} 2>&1; echo "rc=$?"`;
}

/** `qm shutdown <vmid>` — ACPI request with an optional forceStop fallback. */
export function shutdownScript(vmid, options = {}) {
  const args = [];
  if (Number.isFinite(Number(options.timeout))) args.push(`--timeout ${Math.max(0, Math.trunc(Number(options.timeout)))}`);
  if (options.forceStop === true) args.push('--forceStop 1');
  return `qm shutdown ${vmidArg(vmid)} ${args.join(' ')} 2>&1; echo "rc=$?"`;
}

/** `qm reboot <vmid>` — ACPI reboot. */
export function rebootScript(vmid, options = {}) {
  const args = [];
  if (Number.isFinite(Number(options.timeout))) args.push(`--timeout ${Math.max(0, Math.trunc(Number(options.timeout)))}`);
  return `qm reboot ${vmidArg(vmid)} ${args.join(' ')} 2>&1; echo "rc=$?"`;
}

/** `qm reset <vmid>` — hard reset, like the reset button. */
export function resetScript(vmid) {
  return `qm reset ${vmidArg(vmid)} 2>&1; echo "rc=$?"`;
}

/** `qm destroy <vmid>` — deletes the VM and (optionally) its disks. */
export function destroyScript(vmid, options = {}) {
  const args = [`--purge ${bool(options.purge)}`];
  if (options.destroyUnreferencedDisks === true) args.push('--destroy-unreferenced-disks 1');
  return `qm destroy ${vmidArg(vmid)} ${args.join(' ')} 2>&1; echo "rc=$?"`;
}

/** `qm config <vmid> [--current]` plus the snapshot list, in one round trip. */
export function configScript(vmid, options = {}) {
  const v = vmidArg(vmid);
  const args = options.current === true ? '--current 1' : '';
  return [
    'set -u',
    `echo "###CONFIG"`,
    `qm config ${v} ${args} 2>&1`,
    'echo "###SNAPSHOTS"',
    `qm listsnapshot ${v} 2>&1`,
    'echo "###STATUS"',
    `qm status ${v} 2>&1`,
    'echo "###END"',
  ].join('\n');
}

/** `qm snapshot` / `qm delsnapshot` / `qm rollback`, keyed by action. */
export function snapshotScript(vmid, action, name, options = {}) {
  const v = vmidArg(vmid);
  if (action === 'create') {
    const args = [`--description ${JSON.stringify(String(options.description ?? ''))}`];
    if (options.vmstate === true) args.push('--vmstate 1');
    return `qm snapshot ${v} ${snapshotArg(name)} ${args.join(' ')} 2>&1; echo "rc=$?"`;
  }
  if (action === 'delete') {
    const args = options.force === true ? '--force 1' : '';
    return `qm delsnapshot ${v} ${snapshotArg(name)} ${args} 2>&1; echo "rc=$?"`;
  }
  return `qm rollback ${v} ${snapshotArg(name)} 2>&1; echo "rc=$?"`;
}

/** `qm sendkey <vmid> <key>` — works through QMP, so it does not need the guest agent. */
export function sendkeyScript(vmid, key) {
  const text = String(key ?? '').trim();
  if (!text) throw new VmError('BAD_ARGS', 'a key name is required, e.g. "ret", "esc", "ctrl-alt-f2"');
  if (!/^[A-Za-z0-9+-]{1,40}$/.test(text)) {
    throw new VmError('BAD_ARGS', `"${text}" is not a key name`, { hint: 'qm sendkey takes names such as ret, esc, tab, ctrl-alt-delete' });
  }
  return `qm sendkey ${vmidArg(vmid)} ${text} 2>&1; echo "rc=$?"`;
}

/** `qm migrate <vmid> <target>` — live migration inside the cluster. */
export function migrateScript(vmid, target, options = {}) {
  const args = [];
  if (options.online === true) args.push('--online 1');
  if (options.withLocalDisks === true) args.push('--with-local-disks 1');
  if (options.targetstorage) args.push(`--targetstorage ${storageArg(options.targetstorage)}`);
  if (Number.isFinite(Number(options.bwlimit))) args.push(`--bwlimit ${Math.max(0, Math.trunc(Number(options.bwlimit)))}`);
  return `qm migrate ${vmidArg(vmid)} ${nodeArg(target)} ${args.join(' ')} 2>&1; echo "rc=$?"`;
}

/**
 * A clone command whose string options are quoted the only way bash-safe here: single quotes with
 * inner single quotes escaped, because a VM name is free text and must never be split by the shell.
 */
export function cloneCommand(sourceVmid, newid, options = {}) {
  const args = [];
  if (options.name) args.push(`--name ${sq(String(options.name).slice(0, 63))}`);
  if (options.target) args.push(`--target ${sq(nodeArg(options.target))}`);
  if (options.storage) args.push(`--storage ${sq(storageArg(options.storage))}`);
  if (options.snapname) args.push(`--snapname ${sq(snapshotArg(options.snapname))}`);
  if (options.pool) args.push(`--pool ${sq(String(options.pool).slice(0, 64))}`);
  if (options.full === true) args.push('--full 1');
  if (Number.isFinite(Number(options.bwlimit))) args.push(`--bwlimit ${Math.max(0, Math.trunc(Number(options.bwlimit)))}`);
  return { command: `qm clone ${vmidArg(sourceVmid)} ${vmidArg(newid)} ${args.join(' ')}`, newid: vmidArg(newid) };
}

/** POSIX single-quote a value for a bash command line. */
export function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** `pvesh get /nodes/<node>/tasks` — the async half of every clone/migrate/backup. */
export function taskListScript(options = {}) {
  const parts = ['--output-format json'];
  if (Number.isFinite(Number(options.limit))) parts.push(`--limit ${Math.max(1, Math.min(500, Math.trunc(Number(options.limit))))}`);
  if (options.vmid) parts.push(`--vmid ${vmidArg(options.vmid)}`);
  if (options.type) parts.push(`--type ${sq(String(options.type).slice(0, 40))}`);
  if (options.source) parts.push(`--source ${sq(String(options.source).slice(0, 20))}`);
  return `pvesh get /nodes/$(hostname)/tasks ${parts.join(' ')} 2>&1`;
}

/** `pvesh get /nodes/<node>/tasks/<upid>/status` */
export function taskStatusScript(upid) {
  const parsed = parseUpid(upid);
  return `pvesh get /nodes/${parsed.node}/tasks/${parsed.upid}/status --output-format json 2>&1`;
}

/** `pvesh get /nodes/<node>/tasks/<upid>/log` */
export function taskLogScript(upid, options = {}) {
  const parsed = parseUpid(upid);
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(500, Math.trunc(Number(options.limit)))) : 60;
  return [
    `pvesh get /nodes/${parsed.node}/tasks/${parsed.upid}/log --output-format json 2>&1`,
    `echo "###TAIL"`,
    `pvesh get /nodes/${parsed.node}/tasks/${parsed.upid}/log --output-format json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(row.get("t","").rstrip()) for row in d[-${limit}:]]' 2>&1`,
  ].join('\n');
}

/** `pvesh get /nodes/<node>/storage/<storage>/content` — ISOs, templates, backups, disk images. */
export function storageContentScript(storage, options = {}) {
  const parts = ['--output-format json'];
  if (options.content) parts.push(`--content ${sq(String(options.content).slice(0, 40))}`);
  if (options.vmid) parts.push(`--vmid ${vmidArg(options.vmid)}`);
  return `pvesh get /nodes/$(hostname)/storage/${storageArg(storage)}/content ${parts.join(' ')} 2>&1`;
}

/** Every storage definition the node knows, so a caller can discover names instead of guessing. */
export function storageListScript() {
  return `pvesh get /nodes/$(hostname)/storage --output-format json 2>&1`;
}

/** `qm guest cmd <vmid> <command>` — the QGA half that is not "run a script". */
export function guestCmdScript(vmid, command) {
  const allowed = new Set([
    'fsfreeze-freeze',
    'fsfreeze-status',
    'fsfreeze-thaw',
    'fstrim',
    'get-fsinfo',
    'get-host-name',
    'get-memory-block-info',
    'get-memory-blocks',
    'get-osinfo',
    'get-time',
    'get-timezone',
    'get-users',
    'get-vcpus',
    'info',
    'network-get-interfaces',
    'ping',
    'shutdown',
    'suspend-disk',
    'suspend-hybrid',
    'suspend-ram',
  ]);
  const cmd = String(command ?? '').trim();
  if (!allowed.has(cmd)) {
    throw new VmError('BAD_ARGS', `"${cmd}" is not a QGA command this tool sends`, { allowed: [...allowed] });
  }
  return `qm guest cmd ${vmidArg(vmid)} ${cmd} 2>&1; echo "rc=$?"`;
}

/* ------------------------------------------------------------------ parsing */

/** `qm config` text into a flat object plus the handful of fields worth deriving. */
export function parseConfig(text, snapshotLines = '') {
  const config = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('###')) continue;
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!key) continue;
    config[key] = value;
  }
  const mb = Number.parseFloat(config.memory ?? '');
  const disks = Object.keys(config)
    .filter((key) => /^(ide|sata|scsi|virtio)\d+$/.test(key))
    .map((key) => ({ key, value: config[key] }));
  const nets = Object.keys(config)
    .filter((key) => /^net\d+$/.test(key))
    .map((key) => ({ key, value: config[key] }));
  return {
    name: config.name ?? null,
    cores: Number.isFinite(Number(config.cores)) ? Number(config.cores) : null,
    sockets: Number.isFinite(Number(config.sockets)) ? Number(config.sockets) : null,
    memory_mb: Number.isFinite(mb) ? Math.round(mb) : null,
    ostype: config.ostype ?? null,
    boot: config.boot ?? null,
    agent: /(^|,)enabled=1(,|$)/.test(config.agent ?? '') || config.agent === '1' ? true : config.agent === undefined ? null : false,
    scsihw: config.scsihw ?? null,
    bios: config.bios ?? null,
    machine: config.machine ?? null,
    onboot: config.onboot === '1' ? true : config.onboot === '0' ? false : null,
    disks,
    nets,
    config,
    snapshots: parseSnapshots(snapshotLines),
  };
}

/** `qm listsnapshot` into [{name, at, description, current}]. */
export function parseSnapshots(text) {
  const rows = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    const match = /^\s*(?:`->|\*)?\s*(-|[A-Za-z0-9][A-Za-z0-9._-]*)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1];
    if (name === 'current') continue;
    const description = match[4].trim().replace(/\s+/g, ' ');
    rows.push({ name, at: `${match[2]} ${match[3]}`, description: description || null });
  }
  return rows;
}

/** `qm status` text into a status word. */
export function parseStatusLine(text) {
  const match = /status:\s*([a-z]+)/i.exec(String(text ?? ''));
  return match ? match[1].toLowerCase() : null;
}

/** The trailing `rc=` marker every script appends. */
export function parseRc(text) {
  const match = /(?:^|\n)rc=(-?\d+)\s*$/.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

/** Strip the `rc=` trailer so the body can be shown or matched. */
export function bodyOf(text) {
  return String(text ?? '').replace(/(?:^|\n)rc=-?\d+\s*$/, '').trim();
}

/** pvesh JSON, tolerating the empty/garbage replies a half-broken pvesh can produce. */
export function parseJson(text, code = 'SSH_FAILED') {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new VmError(code, 'the node did not return JSON', { output: bodyOf(trimmed).slice(0, 400) });
  }
}

/** Task rows with the fields a caller needs, newest first. */
export function compactTasks(list) {
  if (!Array.isArray(list)) return [];
  return list.map((task) => ({
    upid: task.upid,
    type: task.type ?? null,
    vmid: task.id ?? null,
    node: task.node ?? null,
    user: task.user ?? null,
    status: task.status ?? null,
    started_at: Number.isFinite(Number(task.starttime)) ? Number(task.starttime) : null,
    ended_at: Number.isFinite(Number(task.endtime)) ? Number(task.endtime) : null,
    running: task.status === 'running',
  }));
}

/** Storage content rows: volume, format, size and what it is. */
export function compactStorageContent(list) {
  if (!Array.isArray(list)) return [];
  // Spread only what the pool actually reported: the output schema is strict, and a null here would
  // fail the whole call over a field the storage simply does not use for that content type.
  return list.map((row) => {
    const out = {};
    for (const key of ['volid', 'storage', 'content', 'format']) {
      if (row[key] !== null && row[key] !== undefined) out[key] = String(row[key]);
    }
    for (const key of ['size', 'vmid', 'ctime']) {
      const value = Number(row[key]);
      if (Number.isFinite(value)) out[key] = value;
    }
    if (row.notes !== null && row.notes !== undefined && String(row.notes).trim() !== '') {
      out.notes = String(row.notes).slice(0, 120);
    }
    return out;
  });
}

/** Storage definitions from `pvesh get .../storage`. */
export function compactStorageDefs(list) {
  if (!Array.isArray(list)) return [];
  return list.map((row) => {
    const out = {};
    for (const key of ['storage', 'type', 'content']) {
      if (row[key] !== null && row[key] !== undefined) out[key] = String(row[key]);
    }
    const active = row.active === 1 || row.active === true ? true : row.active === 0 || row.active === false ? false : null;
    if (active !== null) out.active = active;
    out.shared = row.shared === 1 || row.shared === true;
    for (const key of ['total', 'used', 'avail']) {
      const value = Number(row[key]);
      if (Number.isFinite(value)) out[key] = value;
    }
    return out;
  });
}

/**
 * QGA `network-get-interfaces` into the only thing an operator wants: which IPs the guest has.
 * IPv4 first, loopback and link-local dropped.
 */
export function parseInterfaces(text) {
  const parsed = parseJson(text, 'AGENT_DOWN');
  if (!Array.isArray(parsed)) return [];
  const rows = [];
  for (const iface of parsed) {
    const name = iface.name ?? null;
    const mac = iface['hardware-address'] ?? null;
    for (const addr of iface['ip-addresses'] ?? []) {
      const ip = addr['ip-address'] ?? null;
      const type = addr['ip-address-type'] ?? null;
      if (!ip) continue;
      if (ip === '127.0.0.1' || ip === '::1') continue;
      if (ip.startsWith('169.254.') || ip.toLowerCase().startsWith('fe80')) continue;
      const row = { interface: name === null ? 'unknown' : String(name), ip: String(ip) };
      if (mac !== null && mac !== undefined && String(mac).trim() !== '') row.mac = String(mac);
      if (type !== null && type !== undefined) row.type = String(type);
      const prefix = Number(addr.prefix);
      if (Number.isFinite(prefix)) row.prefix = prefix;
      rows.push(row);
    }
  }
  rows.sort((a, b) => (a.type === b.type ? String(a.ip).localeCompare(String(b.ip)) : a.type === 'ipv4' ? -1 : 1));
  return rows;
}

/** QGA `get-osinfo` into a flat object, or null when the agent has nothing to say. */
export function parseOsInfo(text) {
  try {
    const parsed = parseJson(text, 'AGENT_DOWN');
    if (!parsed || typeof parsed !== 'object') return null;
    // Only keys the agent actually answered: an explicit null would fail the strict output schema,
    // and "the agent did not say" is the same thing as absent here.
    const out = {};
    const put = (key, value) => {
      if (value !== null && value !== undefined && String(value).trim() !== '') out[key] = String(value);
    };
    put('name', parsed.name ?? parsed.pretty_name);
    put('pretty_name', parsed['pretty-name']);
    put('version', parsed.version);
    put('version_id', parsed['version-id']);
    put('kernel', parsed['kernel-release']);
    put('machine', parsed.machine);
    put('hostname', parsed.hostname);
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
