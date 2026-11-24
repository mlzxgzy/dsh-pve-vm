/**
 * Cluster parsing and clusterMode behaviour, against a fixture captured from a real cluster
 * (`dev/fixtures/cluster-real.txt`: pve-cluster-02, 7 nodes, one pvesh resource list).
 *
 * There is no standalone PVE host on this network, so the "not part of a cluster" branch is
 * exercised here with a fixture instead of a live node. Everything else in this file — the
 * membership map, the vote counts, the resource compaction — is real output.
 *
 *   ELECTRON_RUN_AS_NODE=1 /usr/lib/deepseek-harness-desktop/deepseek-harness dev/test-cluster.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Cluster, parseMembers, parsePvecmNodes, parsePvecmStatus, sections } from '../lib/cluster.js';
import { NodeRegistry } from '../lib/nodes.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'cluster-real.txt'), 'utf8');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ''}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
}

function settings(overrides = {}) {
  return {
    ssh: {
      hosts: ['192.168.90.104'],
      user: 'root',
      port: 22,
      keyPath: '',
      sshConfig: '',
      extraOptions: [],
      connectTimeoutMs: 8000,
    },
    clusterMode: 'auto',
    clusterCacheMs: 15000,
    defaultVmid: 0,
    allowedVmids: [],
    tmpfsDir: '/dev/shm/pve-rec',
    localOutDir: 'pve-rec',
    allowGuestExec: true,
    guestTimeoutMs: 120000,
    qmpTimeoutMs: 3000,
    burstMaxSeconds: 60,
    maxGuestOutputBytes: 8192,
    frameFormat: 'jpeg',
    frameQuality: 4,
    auditLog: '',
    ...overrides,
  };
}

/** A transport that answers the cluster script and `qm status` without touching the network. */
function fakeTransport({ answer, probe = 'status: running' }) {
  return {
    calls: [],
    async run(host, script) {
      this.calls.push({ host, script });
      if (typeof answer === 'function') return answer(host, script);
      if (script.includes('###HOST')) return { code: 0, stdout: answer, stderr: '', ms: 1, bytes: answer.length };
      if (script.includes('qm status')) {
        return { code: 0, stdout: `pve04\n${probe}\nrc=0\n`, stderr: '', ms: 1, bytes: 20 };
      }
      return { code: 0, stdout: '', stderr: '', ms: 1, bytes: 0 };
    },
  };
}

console.log('parsing the real fixture');
{
  const parts = sections(fixture);
  const members = parseMembers(parts.MEMBERS);
  const pvecm = parsePvecmStatus(parts.PVECM);
  const votes = parsePvecmNodes(parts.PVECMNODES);
  const resources = JSON.parse(parts.RESOURCES);

  check('cluster name', members.cluster?.name === 'pve-cluster-02', members.cluster?.name);
  check('quorate', members.cluster?.quorate === true || members.cluster?.quorate === 1, String(members.cluster?.quorate));
  check('node count', members.nodes.length === 7, String(members.nodes.length));
  check('nodename -> address', members.nodes.find((n) => n.name === 'pve05')?.ip === '192.168.90.105');
  check('pvecm expected votes', pvecm.expected_votes === 7, String(pvecm.expected_votes));
  check('pvecm transport', pvecm.transport === 'knet', String(pvecm.transport));
  check('pvecm votes 7', pvecm.votes === 7, String(pvecm.votes));
  check('pvecm nodes names', votes.filter((row) => /^pve\d\d$/.test(row.name)).length === 7, `${votes.length} rows`);
  check('fixture keeps a VM', resources.some((entry) => entry.vmid === 15047));
}

console.log('cluster snapshot (mode auto)');
{
  const transport = fakeTransport({ answer: fixture });
  const cluster = new Cluster({ settings: () => settings(), transport });
  const snapshot = await cluster.ensure({ host: '192.168.90.104' });

  check('standalone is false', snapshot.standalone === false, String(snapshot.standalone));
  check('seed recorded', snapshot.seed.node === 'pve04', snapshot.seed.node);
  check('7 nodes with addresses', snapshot.nodes.filter((n) => n.ip).length === 7);
  check('one vote per node', snapshot.nodes.find((n) => n.name === 'pve06')?.votes === 1, String(snapshot.nodes.find((n) => n.name === 'pve06')?.votes));
  check('address of pve01', Cluster.addressOf(snapshot, 'pve01') === '192.168.90.101');
  check(
    'address of pve04 falls back to the seed',
    Cluster.addressOf(snapshot, 'pve04') === '192.168.90.104',
    Cluster.addressOf(snapshot, 'pve04') ?? 'null',
  );
  check('findVmid 15047 -> pve04', Cluster.findVmid(snapshot, 15047)?.node === 'pve04');
  check('vms() only lists guests', Cluster.vms(snapshot).every((vm) => vm.vmid !== undefined));
  check('every VM names its node', Cluster.vms(snapshot).every((vm) => typeof vm.node === 'string'));
}

console.log('standalone node (mode auto) — no /etc/pve/.members');
{
  const standalone = '###HOST\npve04\n###MEMBERS\n\n###PVECM\n\n###PVECMNODES\n\n###RESOURCES\n' +
    JSON.stringify([
      {
        id: 'qemu/15047',
        type: 'qemu',
        vmid: 15047,
        name: 'winsrv2016',
        node: 'pve04',
        status: 'running',
        maxcpu: 4,
        maxmem: 4294967296,
        maxdisk: 34359738368,
        uptime: 100,
      },
    ]);
  const transport = fakeTransport({ answer: standalone });
  const cluster = new Cluster({ settings: () => settings(), transport });
  const snapshot = await cluster.ensure({ host: '192.168.90.104' });

  check('standalone is true', snapshot.standalone === true, String(snapshot.standalone));
  check('one synthetic node', snapshot.nodes.length === 1, String(snapshot.nodes.length));
  check('node has no ip in .members', snapshot.nodes[0].ip === null, String(snapshot.nodes[0].ip));
  check(
    'addressOf falls back to the seed host',
    Cluster.addressOf(snapshot, 'pve04') === '192.168.90.104',
    Cluster.addressOf(snapshot, 'pve04') ?? 'null',
  );
  check('the VM is still found', Cluster.findVmid(snapshot, 15047)?.vmid === 15047);
}

console.log('standalone node with clusterMode "on" — must refuse');
{
  const standalone = '###HOST\npve04\n###MEMBERS\n\n###PVECM\n\n###PVECMNODES\n\n###RESOURCES\n[]';
  const transport = fakeTransport({ answer: standalone });
  const cluster = new Cluster({ settings: () => settings({ clusterMode: 'on' }), transport });
  let error = null;
  try {
    await cluster.ensure({ host: '192.168.90.104' });
  } catch (caught) {
    error = caught;
  }
  check('throws NOT_A_CLUSTER', error?.code === 'NOT_A_CLUSTER', error?.code ?? 'no error');
  check('says which host', String(error?.message ?? '').includes('192.168.90.104'), error?.message ?? '');
  check('carries details.hosts', Array.isArray(error?.extra?.hosts) && error.extra.hosts.length === 1);
  check('every tool-facing failure value is canonical', error?.toValue?.().ok === false);
}

console.log('unreachable seed');
{
  const transport = {
    async run() {
      throw Object.assign(new Error('ssh 192.168.90.199 failed (exit 255): Connection timed out'), { code: 'SSH_FAILED' });
    },
  };
  const cluster = new Cluster({ settings: () => settings({ ssh: { ...settings().ssh, hosts: ['192.168.90.199'] } }), transport });
  let error = null;
  try {
    await cluster.ensure();
  } catch (caught) {
    error = caught;
  }
  check('throws NODE_UNREACHABLE', error?.code === 'NODE_UNREACHABLE', error?.code ?? 'no error');
}

console.log('NodeRegistry: cluster fast path');
{
  const transport = fakeTransport({ answer: fixture });
  const cluster = new Cluster({ settings: () => settings(), transport });
  const registry = new NodeRegistry({ settings: () => settings(), transport, cluster });

  const listed = await registry.listVms({ host: '192.168.90.104' });
  check('source is cluster', listed.source === 'cluster', listed.source);
  check('vms mapped with a host', listed.vms.every((vm) => typeof vm.host === 'string'), `${listed.vms.length} vms`);

  const resolved = await registry.resolve(15047, { host: '192.168.90.104' });
  check('resolved through the cluster', resolved.source === 'cluster', resolved.source);
  check('resolved to the owning address', resolved.host === '192.168.90.104', resolved.host);
  check('node name from the cluster', resolved.node === 'pve04', resolved.node);
  check('status from qm status', resolved.status === 'running', resolved.status);
}

console.log('NodeRegistry: standalone resolve uses the seed address');
{
  const standalone = '###HOST\npve04\n###MEMBERS\n\n###PVECM\n\n###PVECMNODES\n\n###RESOURCES\n' +
    JSON.stringify([
      {
        id: 'qemu/15047',
        type: 'qemu',
        vmid: 15047,
        name: 'winsrv2016',
        node: 'pve04',
        status: 'running',
        maxcpu: 4,
        maxmem: 4294967296,
        maxdisk: 34359738368,
        uptime: 100,
      },
    ]);
  const transport = fakeTransport({ answer: standalone });
  const cluster = new Cluster({ settings: () => settings(), transport });
  const registry = new NodeRegistry({ settings: () => settings(), transport, cluster });
  const resolved = await registry.resolve(15047, { host: '192.168.90.104' });
  check('resolved to the seed address', resolved.host === '192.168.90.104', resolved.host);
  check('source is cluster', resolved.source === 'cluster', resolved.source);
}

console.log('NodeRegistry: clusterMode "off" never reads the cluster');
{
  const transport = fakeTransport({ answer: fixture });
  const cluster = new Cluster({ settings: () => settings({ clusterMode: 'off' }), transport });
  const registry = new NodeRegistry({ settings: () => settings({ clusterMode: 'off' }), transport, cluster });
  await registry.listVms({ host: '192.168.90.104' }).catch(() => null);
  check(
    'the cluster script was never asked',
    transport.calls.every((call) => !call.script.includes('###HOST')),
    `${transport.calls.length} calls`,
  );
}

console.log('');
if (failures > 0) {
  console.log(`CLUSTER TEST FAILED: ${failures} check(s)`);
  process.exitCode = 1;
} else {
  console.log('CLUSTER TEST OK');
}
