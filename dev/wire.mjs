/**
 * Load index.js the way the harness does, without a harness: check that apply() registers the
 * tools we expect, that the conditional tool obeys allowGuestExec, and that every definition
 * carries a name, description, parameters, output schema and render.
 */
import { apply, name, inject, Config } from '../index.js';

const values = {
  nodes: ['192.168.90.104'],
  sshUser: 'root',
  sshPort: 22,
  sshKeyPath: '',
  sshConfigFile: '/dev/null',
  sshExtraOptions: [],
  connectTimeoutMs: 8000,
  defaultVmid: 15047,
  allowedVmids: [15047],
  tmpfsDir: '/dev/shm/pve-rec',
  localOutDir: '.smoke',
  allowGuestExec: true,
  guestTimeoutMs: 120000,
  qmpTimeoutMs: 3000,
  burstMaxSeconds: 60,
  maxGuestOutputBytes: 8192,
  frameFormat: 'jpeg',
  frameQuality: 4,
  auditLog: '',
};

function config(overrides = {}) {
  const merged = { ...values, ...overrides };
  const live = {};
  for (const [key, value] of Object.entries(merged)) live[key] = { get: () => value };
  return live;
}

const registered = [];
const cleaning = [];
const ctx = {
  tools: { register: (definition, options) => registered.push({ definition, options }) },
  subprocess: { spawn: () => { throw new Error('not used in wiring check'); } },
  effect: (factory) => cleaning.push(factory()),
  get: () => undefined,
};
apply(ctx, config());
const names = registered.map((entry) => entry.definition.name);
console.log('name:', name, '| inject:', inject.join(','));
console.log('tools:', names.join(', '));
let ok = true;
for (const { definition } of registered) {
  const problems = [];
  if (!definition.name) problems.push('no name');
  if (!definition.description || definition.description.length < 40) problems.push('thin description');
  if (!definition.parameters || typeof definition.parameters !== 'object') problems.push('no parameters');
  if (!definition.output?.schema) problems.push('no output schema');
  if (typeof definition.output?.render !== 'function') problems.push('no render');
  if (typeof definition.execute !== 'function') problems.push('no execute');
  if (problems.length > 0) { ok = false; console.log('BAD', definition.name, problems.join(', ')); }
}
const conditional = registered.find((entry) => entry.definition.name === 'pve_guest_exec');
const gate = conditional?.options?.when;
const gatedOn = typeof gate === 'function' && (await gate({})) === true;
const offRegistered = [];
const ctxOff = { ...ctx, tools: { register: (definition, options) => offRegistered.push({ definition, options }) } };
apply(ctxOff, config({ allowGuestExec: false }));
const conditionalOff = offRegistered.find((entry) => entry.definition.name === 'pve_guest_exec');
const gatedOff = typeof conditionalOff?.options?.when === 'function' && (await conditionalOff.options.when({})) === false;
console.log('guest_exec gated when enabled:', gatedOn, '| hidden when disabled:', gatedOff);
console.log('expected 9 tools:', names.length === 9);
console.log(ok && names.length === 9 ? 'WIRING OK' : 'WIRING FAILED');
for (const dispose of cleaning) if (typeof dispose === 'function') dispose();
