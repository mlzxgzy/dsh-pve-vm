import { spawnCompat } from './harness.mjs';
import { resolveSettings, snapshot } from '../lib/config.js';
import { Transport } from '../lib/ssh.js';
import { envelope, encodeCommand } from '../lib/guest.js';

const values = { nodes: ['192.168.90.104'], sshUser: 'root', sshPort: 22, sshKeyPath: '', sshConfigFile: '/dev/null',
  sshExtraOptions: [], connectTimeoutMs: 8000, defaultVmid: 15047, allowedVmids: [15047], tmpfsDir: '/dev/shm/pve-rec',
  localOutDir: '.smoke', allowGuestExec: true, guestTimeoutMs: 120000, qmpTimeoutMs: 3000, burstMaxSeconds: 60,
  maxGuestOutputBytes: 8192, frameFormat: 'jpeg', frameQuality: 4, auditLog: '' };
const live = {};
for (const [k, v] of Object.entries(values)) live[k] = { get: () => v };
const settings = () => resolveSettings(snapshot(live));
const transport = new Transport({ settings, spawn: spawnCompat, cwd: process.cwd() });

const script = '"hi"; (Get-Process -Id $PID).SessionId';
const encoded = encodeCommand(envelope(script));
const command = `/usr/sbin/qm guest exec 15047 --timeout 120 -- powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
const result = await transport.run('192.168.90.104', `${command}\n`, { timeoutMs: 140000, allowNonZero: true, maxBytes: 1 << 20 });
console.log('code', result.code, 'ms', result.ms, 'stdout bytes', result.bytes);
console.log('STDOUT >>>');
console.log(result.stdout);
console.log('<<< STDERR >>>');
console.log(result.stderr.slice(-600));
console.log('<<<');
