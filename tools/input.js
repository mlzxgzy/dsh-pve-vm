/**
 * Input tools: they run PowerShell **in the guest's interactive session 1**, not through the guest
 * agent.
 *
 * The agent service lives in session 0, and session 0 has no desktop: input injected there reaches
 * nothing visible. So the script is handed to the session-1 bridge (a scheduled task with an
 * interactive token), which is why every call here costs 2–4 s instead of milliseconds.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { clickScript, keyExpression, keyScript, typeScript } from '../lib/actions.js';
import { VmError, guard } from '../lib/errors.js';
import { agentPing, queryVmStatus } from '../lib/ssh.js';
import { schema, textRender, seconds, VMID_PARAM } from './common.js';

/** Screen guards: the guest desktop is 1280x800, but a resized console can be larger. */
const COORD_MAX = 8192;

/**
 * Resolve the node and make sure the VM is running with a live agent.
 * @param {object} deps plugin dependencies.
 * @param {object} args tool arguments.
 * @param {object|undefined} exec execution context.
 * @returns {Promise<{vmid:number, node:string}>} target.
 */
async function target(deps, args, exec) {
  const vmid = deps.registry.assertVmid(args.vmid);
  const resolved = await deps.registry.resolve(vmid, { signal: exec?.signal });
  const node = resolved.node;
  const status = await queryVmStatus(deps.transport, node, vmid);
  if (status.status !== 'running') throw new VmError('VM_STOPPED', `VM ${vmid} is ${status.status ?? 'unknown'} on ${node}`);
  if (!(await agentPing(deps.transport, node, vmid))) {
    throw new VmError('AGENT_DOWN', `guest agent of VM ${vmid} does not answer on ${node}`);
  }
  return { vmid, node };
}

/**
 * Build the input tools.
 * @param {object} deps plugin dependencies.
 * @returns {object[]} tool definitions.
 */
export function inputTools(deps) {
  return [
    defineTool({
      name: 'pve_click',
      description:
        'Click at a pixel coordinate of the VM screen. The pointer is moved there in 14 small steps before ' +
        'the button goes down — a teleporting cursor is treated as a hover by some Windows controls and the ' +
        'click is lost. Coordinates are screen pixels of the frame pve_screenshot returned. Do NOT assume one ' +
        'click equals one page turn: injected events are batched by the input stack, so verify with a screenshot.',
      parameters: {
        vmid: VMID_PARAM,
        x: { type: 'number', required: true, description: 'X in screen pixels (0 … 8191), measured on the screenshot.' },
        y: { type: 'number', required: true, description: 'Y in screen pixels (0 … 8191), measured on the screenshot.' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button (default left).',
        },
        clicks: { type: 'number', description: 'Clicks to perform at that point, 1…3 (default 1).' },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'VM id.' },
          node: { type: 'string', description: 'Node the guest runs on.' },
          x: { type: 'number', description: 'X that was clicked.' },
          y: { type: 'number', description: 'Y that was clicked.' },
          button: { type: 'string', description: 'Mouse button used.' },
          clicks: { type: 'number', description: 'Clicks performed at that point.' },
          output: { type: 'string', description: 'What the guest reported (it echoes the cursor position afterwards).' },
          ms: { type: 'number', description: 'Round trip through the session-1 bridge.' },
        }),
        render: textRender('Click sent', (value) =>
          [`clicked ${value.x},${value.y} on VM ${value.vmid} in ${seconds(value.ms)}`, value.output?.trim() ?? ''].join('\n'),
        ),
      },
      timeoutMs: 120000,
      async execute(args, exec) {
        return guard(async () => {
          const x = Number(args.x);
          const y = Number(args.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new VmError('BAD_ARGS', 'x and y must be numbers');
          if (x < 0 || y < 0 || x > COORD_MAX || y > COORD_MAX) {
            throw new VmError('BAD_ARGS', `x and y must be within 0…${COORD_MAX}, got ${x},${y}`);
          }
          const { vmid, node } = await target(deps, args, exec);
          const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left';
          const clicks = Math.max(1, Math.min(3, Math.round(Number(args.clicks ?? 1))));
          const result = await deps.bridge.run({
            node,
            vmid,
            body: clickScript({ x: Math.round(x), y: Math.round(y), button, clicks, doubleClick: clicks > 1 }),
            timeoutMs: 60000,
            signal: exec?.signal,
          });
          return {
            ok: true,
            vmid,
            node,
            x: Math.round(x),
            y: Math.round(y),
            button,
            clicks,
            output: result.output,
            ms: result.ms,
          };
        });
      },
    }),

    defineTool({
      name: 'pve_type',
      description:
        'Type text into the VM at the current keyboard focus, as keystrokes (SendKeys). Use it after clicking ' +
        'into the field: it does not move focus itself. Only keys SendKeys can express are typed — a newline ' +
        'becomes Enter, a tab becomes Tab, and the characters + ^ % ~ ( ) { } [ ] are typed literally by ' +
        'escaping them. Long text is typed in one batch: verify with a screenshot instead of assuming.',
      parameters: {
        vmid: VMID_PARAM,
        text: { type: 'string', required: true, description: 'Text to type. Max 2000 characters.' },
        enter: { type: 'boolean', description: 'Press Enter after the text (default false).' },
        delayMs: {
          type: 'number',
          description: 'Pause after typing before the Enter, ms (default 120). Raise it for slow dialogs.',
        },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'VM id.' },
          node: { type: 'string', description: 'Node the guest runs on.' },
          chars: { type: 'number', description: 'Characters typed.' },
          enter: { type: 'boolean', description: 'Enter was pressed afterwards.' },
          output: { type: 'string', description: 'Guest reply.' },
          ms: { type: 'number', description: 'Round trip through the session-1 bridge.' },
        }),
        render: textRender('Text typed', (value) =>
          [`typed ${value.chars} characters${value.enter ? ' and pressed Enter' : ''} in ${seconds(value.ms)}`].join('\n'),
        ),
      },
      timeoutMs: 180000,
      async execute(args, exec) {
        return guard(async () => {
          const text = typeof args.text === 'string' ? args.text : '';
          if (text.length === 0) throw new VmError('BAD_ARGS', 'text is empty');
          if (text.length > 2000) throw new VmError('BAD_ARGS', 'text is longer than 2000 characters');
          const { vmid, node } = await target(deps, args, exec);
          const enter = args.enter === true;
          const delayMs = Math.max(0, Math.min(5000, Math.round(Number(args.delayMs ?? 120))));
          const result = await deps.bridge.run({
            node,
            vmid,
            body: typeScript({ text, enter, delayMs }),
            timeoutMs: 120000,
            signal: exec?.signal,
          });
          return { ok: true, vmid, node, chars: [...text].length, enter, output: result.output, ms: result.ms };
        });
      },
    }),

    defineTool({
      name: 'pve_key',
      description:
        'Press one key or a chord in the VM. Names are friendly (enter, tab, esc, space, f1…f12, up/down/left/' +
        'right, home, end, pgup, pgdn, delete, win) or chords (ctrl+a, ctrl+shift+esc, alt+f4). A raw SendKeys ' +
        'expression such as "^a" or "%{F4}" is passed through unchanged. This is the reliable path for a ' +
        'control that ignores injected mouse clicks (checkboxes do that) — press space or tab instead.',
      parameters: {
        vmid: VMID_PARAM,
        key: {
          type: 'string',
          required: true,
          description: 'Key name, chord (`ctrl+a`, `alt+f4`) or a raw SendKeys expression (`^a`, `%{F4}`).',
        },
        repeat: { type: 'number', description: 'How many times to press it, 1…50 (default 1).' },
        delayMs: { type: 'number', description: 'Pause between presses, ms (default 120).' },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'VM id.' },
          node: { type: 'string', description: 'Node the guest runs on.' },
          expression: { type: 'string', description: 'SendKeys expression that was sent.' },
          repeat: { type: 'number', description: 'Presses performed.' },
          output: { type: 'string', description: 'Guest reply.' },
          ms: { type: 'number', description: 'Round trip through the session-1 bridge.' },
        }),
        render: textRender('Key sent', (value) =>
          [`pressed ${value.expression} × ${value.repeat} in ${seconds(value.ms)}`].join('\n'),
        ),
      },
      timeoutMs: 180000,
      async execute(args, exec) {
        return guard(async () => {
          const expression = keyExpression(args.key);
          if (expression.length === 0) throw new VmError('BAD_ARGS', 'key is empty');
          const { vmid, node } = await target(deps, args, exec);
          const repeat = Math.max(1, Math.min(50, Math.round(Number(args.repeat ?? 1))));
          const delayMs = Math.max(0, Math.min(5000, Math.round(Number(args.delayMs ?? 120))));
          const result = await deps.bridge.run({
            node,
            vmid,
            body: keyScript({ keys: expression, repeat, delayMs }),
            timeoutMs: 120000,
            signal: exec?.signal,
          });
          return { ok: true, vmid, node, expression, repeat, output: result.output, ms: result.ms };
        });
      },
    }),
  ];
}
