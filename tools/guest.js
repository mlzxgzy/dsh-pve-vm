/**
 * The one dangerous tool: arbitrary PowerShell as SYSTEM inside the guest.
 *
 * It runs through the guest agent (session 0, SYSTEM) — not the session-1 bridge — because the point
 * of the tool is unattended inspection, not driving the desktop. It is off unless the operator turns
 * `allowGuestExec` on, it is hidden from the model entirely in that case (`when` on the registration),
 * and every call is appended to a local audit log with the full script.
 *
 * Output is bounded: the guest reply is cut at `maxGuestOutputBytes` and the result says so, so one
 * accidental `Get-ChildItem -Recurse` cannot flood the conversation.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { appendAudit } from '../lib/audit.js';
import { VmError, guard, truncate } from '../lib/errors.js';
import { encodeCommand, guestExec, MAX_ENCODED } from '../lib/guest.js';
import { agentPing, queryVmStatus } from '../lib/ssh.js';
import { schema, textRender, seconds, sessionCwd, VMID_PARAM } from './common.js';

/**
 * Build the guest tools.
 * @param {object} deps plugin dependencies.
 * @returns {object[]} tool definitions.
 */
export function guestTools(deps) {
  return [
    defineTool({
      name: 'pve_guest_exec',
      description:
        'Run a PowerShell script inside the guest through the guest agent and return its output, exit code and ' +
        'duration. This is arbitrary code as SYSTEM: the tool exists only when the operator enabled ' +
        'allowGuestExec, and every call is written to a local audit log. Output is cut at the configured limit ' +
        '(8 KB by default) and marked when that happened. Does not need an interactive session — that is what ' +
        'the click/type/key tools use.',
      parameters: {
        vmid: VMID_PARAM,
        script: {
          type: 'string',
          required: true,
          description:
            'PowerShell to run. Multi-line is fine. It runs in session 0 as SYSTEM, so desktop APIs and SendKeys ' +
            'do nothing here. Avoid `exit`: it ends the wrapper before output is collected.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Guest-side timeout, ms (default from settings, 120000; max 600000).',
        },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'VM id.' },
          node: { type: 'string', description: 'Node the guest runs on.' },
          stdout: { type: 'string', description: 'Standard output of the script (UTF-8, truncated at the configured limit).' },
          stderr: { type: 'string', description: 'Standard error, when the script wrote any.' },
          exit: { type: 'number', description: 'Exit code reported by the guest.' },
          truncated: { type: 'boolean', description: 'stdout was cut at maxGuestOutputBytes.' },
          bytes: { type: 'number', description: 'Size of the full output, bytes.' },
          audit: { type: 'string', description: 'Path of the audit log that recorded this call.' },
          ms: { type: 'number', description: 'Wall time of the call.' },
        }),
        render: textRender('Guest command finished', (value) =>
          [
            `VM ${value.vmid} on ${value.node}: exit ${value.exit} in ${seconds(value.ms)}` +
              (value.truncated ? ` (output cut at ${value.bytes} bytes)` : ''),
            value.stdout.trim().length > 0 ? value.stdout.trimEnd() : '(no output)',
            value.stderr.trim().length > 0 ? `stderr: ${value.stderr.trimEnd()}` : '',
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
        ),
      },
      timeoutMs: 660000,
      async execute(args, exec) {
        return guard(async () => {
          const settings = deps.settings();
          if (settings.allowGuestExec !== true) {
            // Defence in depth: the registration hides the tool, this catches a stale tool list.
            throw new VmError('GUEST_EXEC_DISABLED', 'allowGuestExec is false in the plugin settings');
          }
          const started = Date.now();
          const script = typeof args.script === 'string' ? args.script : '';
          if (script.trim().length === 0) throw new VmError('BAD_ARGS', 'script is empty');
          const vmid = deps.registry.assertVmid(args.vmid);
          const resolved = await deps.registry.resolve(vmid, { signal: exec?.signal });
          const node = resolved.node;
          const status = await queryVmStatus(deps.transport, node, vmid);
          if (status.status !== 'running') throw new VmError('VM_STOPPED', `VM ${vmid} is ${status.status ?? 'unknown'} on ${node}`);
          const timeoutMs = Math.max(5000, Math.min(600000, Math.round(Number(args.timeoutMs ?? settings.guestTimeoutMs))));
          const encoded = encodeCommand(script);
          if (encoded.length > MAX_ENCODED) {
            throw new VmError(
              'BAD_ARGS',
              `the encoded script is ${encoded.length} characters, over the ${MAX_ENCODED} the guest agent accepts; ` +
                'split it into several calls or move it into a file on the guest',
            );
          }
          let reply;
          try {
            reply = await guestExec({ transport: deps.transport, node, vmid, script, timeoutMs, signal: exec?.signal });
          } catch (error) {
            const audited = await appendAudit(settings, sessionCwd(exec, deps.ctx), {
              tool: 'pve_guest_exec',
              vmid,
              node,
              script,
              error: error instanceof VmError ? `${error.code}: ${error.message}` : String(error),
              ms: Date.now() - started,
            }).catch(() => null);
            if (error instanceof VmError && audited !== null) error.extra.audit = audited.path;
            throw error;
          }
          // `guestExec` already unwrapped the JEV1 envelope: reply.stdout is the guest's stdout.
          const cut = truncate(reply.stdout ?? '', settings.maxGuestOutputBytes);
          const audited = await appendAudit(settings, sessionCwd(exec, deps.ctx), {
            tool: 'pve_guest_exec',
            vmid,
            node,
            script,
            exit: reply.exitcode,
            bytes: cut.bytes,
            truncated: cut.truncated,
            ms: Date.now() - started,
          }).catch(() => null);
          return {
            ok: true,
            vmid,
            node,
            stdout: cut.text,
            stderr: truncate(reply.stderr ?? '', 2048).text,
            exit: reply.exitcode,
            truncated: cut.truncated,
            bytes: cut.bytes,
            ...(audited !== null ? { audit: audited.path } : {}),
            ms: Date.now() - started,
          };
        });
      },
    }),
  ];
}
