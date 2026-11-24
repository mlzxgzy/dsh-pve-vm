/**
 * Local smoke runner: exercises the same lib code the tools call, against a live node.
 *
 *   node dev/smoke.mjs status
 *   node dev/smoke.mjs shot
 *   node dev/smoke.mjs burst <fps> <seconds>
 *   node dev/smoke.mjs stop
 *   node dev/smoke.mjs fetch [from] [to] [max]
 *   node dev/smoke.mjs guest '<powershell>'
 *   node dev/smoke.mjs bridge '<powershell>'
 *   node dev/smoke.mjs click <x> <y>
 *   node dev/smoke.mjs type '<text>'
 *   node dev/smoke.mjs key <expression>
 *
 * This file is a development aid, not part of the plugin runtime.
 */
import { join } from 'node:path';
import { resolveSettings, remotePaths, localDir } from '../lib/config.js';
import { Transport, queryVmStatus, agentPing, waitFor } from '../lib/ssh.js';
import { screendump } from '../lib/qmp.js';
import { parsePpm, writeFrame } from '../lib/img.js';
import { startBurst, burstStatus, stopBurst } from '../lib/burst.js';
import { fetchFrames } from '../lib/frames.js';
import { guestExec } from '../lib/guest.js';
import { SessionBridge } from '../lib/bridge.js';
import { clickScript, typeScript, keyScript, keyExpression } from '../lib/actions.js';
import { spawnCompat } from './harness.mjs';

const CWD = process.cwd();
const settings = resolveSettings({
  nodes: [process.env.PVE_NODE ?? '192.168.90.104'],
  allowedVmids: [Number(process.env.PVE_VMID ?? 15047)],
  defaultVmid: Number(process.env.PVE_VMID ?? 15047),
  localOutDir: '/data1/01-AiWork/jev研究/dsh-plugin/dsh-pve-vm/.smoke',
  allowGuestExec: true,
});
const VMID = settings.defaultVmid;
const transport = new Transport({ settings: () => settings, spawn: spawnCompat, cwd: CWD });
const paths = remotePaths(settings, VMID);
const log = (...parts) => console.log(...parts);

/**
 * Resolve the node that hosts the VM.
 * @returns {Promise<string>} node address.
 */
async function findNode() {
  for (const node of settings.ssh.nodes) {
    const status = await queryVmStatus(transport, node, VMID);
    if (status.status !== null) return node;
  }
  throw new Error(`VM ${VMID} not found on ${settings.ssh.nodes.join(', ')}`);
}

const [command, ...rest] = process.argv.slice(2);
const node = await findNode();
log('node', node);

switch (command) {
  case 'status': {
    const status = await queryVmStatus(transport, node, VMID);
    const pingStart = Date.now();
    const ping = await agentPing(transport, node, VMID);
    const burst = await burstStatus(transport, node, { vmid: VMID, root: paths.root, burst: paths.burst });
    log(JSON.stringify({ ...status, agent: ping, ping_ms: Date.now() - pingStart, burst }, null, 2));
    break;
  }
  case 'shot': {
    const started = Date.now();
    const out = `${paths.shots}/smoke-${Date.now()}.ppm`;
    const shot = await screendump(transport, node, { vmid: VMID, outFile: out, qmpTimeoutMs: settings.qmpTimeoutMs });
    log('dump ms', shot.ms, 'bytes', shot.bytes, 'size', `${shot.width}x${shot.height}`);
    const image = parsePpm(shot.ppm);
    const written = await writeFrame(image, {
      outPath: join(localDir(settings, CWD, `v${VMID}/shots`), `smoke-${Date.now()}.jpg`),
      format: 'jpeg',
      quality: settings.frameQuality,
      spawn: spawnCompat,
      cwd: CWD,
    });
    log('written', written.path, written.bytes, written.format, written.encoder, 'wall', Date.now() - started);
    break;
  }
  case 'burst': {
    const fps = Number(rest[0] ?? 4);
    const seconds = Number(rest[1] ?? 6);
    const started = await startBurst(transport, node, {
      vmid: VMID,
      root: paths.root,
      burst: paths.burst,
      fps,
      seconds,
      qmpTimeoutMs: settings.qmpTimeoutMs,
    });
    log('started', JSON.stringify(started));
    const deadline = started.started_ms + seconds * 1000 + 4000;
    const quiet = await waitFor(
      async () => {
        const state = await burstStatus(transport, node, { vmid: VMID, root: paths.root, burst: paths.burst });
        if (!state.running) return true;
        return Date.now() > deadline;
      },
      { timeoutMs: seconds * 1000 + 20000, intervalMs: 1000 },
    );
    const state = await burstStatus(transport, node, { vmid: VMID, root: paths.root, burst: paths.burst });
    log('after', quiet.ok, JSON.stringify(state));
    break;
  }
  case 'stop': {
    const stopped = await stopBurst(transport, node, { vmid: VMID, root: paths.root, burst: paths.burst });
    log(JSON.stringify(stopped));
    break;
  }
  case 'fetch': {
    const value = await fetchFrames({
      transport,
      node,
      vmid: VMID,
      burstDir: paths.burst,
      localDir: localDir(settings, CWD, `v${VMID}/frames`),
      from: Number(rest[0] ?? 0),
      to: Number(rest[1] ?? 99999),
      max: Number(rest[2] ?? 200),
      format: 'jpeg',
      quality: settings.frameQuality,
      spawn: spawnCompat,
      cwd: CWD,
    });
    log(JSON.stringify(value, null, 2));
    break;
  }
  case 'guest': {
    const script = rest.join(' ');
    const result = await guestExec({ transport, node, vmid: VMID, script, timeoutMs: settings.guestTimeoutMs });
    log('exit', result.exitcode, 'ms', result.ms, 'wrapped', result.wrapped);
    log(result.stdout);
    if (result.stderr.trim().length > 0) log('stderr:', result.stderr.slice(0, 800));
    break;
  }
  case 'bridge': {
    const bridge = new SessionBridge({ transport, settings: () => settings });
    const result = await bridge.run({ node, vmid: VMID, body: rest.join(' '), timeoutMs: 120000 });
    log('ms', result.ms);
    log(result.output);
    break;
  }
  case 'click': {
    const bridge = new SessionBridge({ transport, settings: () => settings });
    const result = await bridge.run({
      node,
      vmid: VMID,
      body: clickScript({ x: Number(rest[0]), y: Number(rest[1]), button: 'left', clicks: 1, doubleClick: false }),
      timeoutMs: 120000,
    });
    log('ms', result.ms, '→', result.output.trim());
    break;
  }
  case 'type': {
    const bridge = new SessionBridge({ transport, settings: () => settings });
    const result = await bridge.run({
      node,
      vmid: VMID,
      body: typeScript({ text: rest.join(' '), enter: false, delayMs: 200 }),
      timeoutMs: 120000,
    });
    log('ms', result.ms, '→', result.output.trim());
    break;
  }
  case 'key': {
    const bridge = new SessionBridge({ transport, settings: () => settings });
    const expression = keyExpression(rest[0]);
    log('expression', JSON.stringify(expression));
    const result = await bridge.run({
      node,
      vmid: VMID,
      body: keyScript({ keys: expression, repeat: Number(rest[1] ?? 1), delayMs: 120 }),
      timeoutMs: 120000,
    });
    log('ms', result.ms, '→', result.output.trim());
    break;
  }
  default:
    log('unknown command', command);
    process.exitCode = 2;
}
