/** Print the declared output properties of every tool, so the returns can be checked against them. */
const { apply } = await import('../index.js');
const registered = [];
const values = { nodes: ['192.168.90.104'], sshUser: 'root', sshPort: 22, sshKeyPath: '', sshConfigFile: '/dev/null',
  sshExtraOptions: [], connectTimeoutMs: 8000, defaultVmid: 15047, allowedVmids: [15047], tmpfsDir: '/dev/shm/pve-rec',
  localOutDir: '.smoke', allowGuestExec: true, guestTimeoutMs: 120000, qmpTimeoutMs: 3000, burstMaxSeconds: 60,
  maxGuestOutputBytes: 8192, frameFormat: 'jpeg', frameQuality: 4, auditLog: '' };
const live = {};
for (const [k, v] of Object.entries(values)) live[k] = { get: () => v };
apply({ tools: { register: (d) => registered.push(d) }, subprocess: { spawn: () => null }, effect: () => () => {}, get: () => undefined }, live);
for (const d of registered) {
  const props = Object.keys(d.output.schema.properties ?? {});
  console.log(d.name + ':\n  ' + props.join(', '));
}
