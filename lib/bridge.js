/**
 * The session-1 bridge: run PowerShell **in the interactive administrator session** of the guest.
 *
 * Why it exists: the guest agent runs as SYSTEM in session 0, where `mouse_event` and `SendKeys`
 * reach nothing and `CopyFromScreen` sees a black desktop. Everything that must look like a human
 * has to run in the logged-in console session (session 1). The only way in without RDP is a
 * scheduled task with `InteractiveToken` whose action is `wscript.exe run.vbs`, and the VBS starts
 * PowerShell **hidden** (`Run(..., 0, True)`) — without the hidden window a conhost window covers
 * the desktop and every screenshot comes out black (playbook A-2, reproduced 2026-11-23).
 *
 * The whole round trip is **one** guest-agent call (~1.5–3 s): write the payload, start the task,
 * poll for the result file, base64 it back. Splitting it into write/run/read costs three calls and
 * three times the latency.
 */
import { VmError } from './errors.js';
import { guestExec } from './guest.js';

/** Marks the end of the guest output; a partial file must not be read as a result. */
const MARK = '__JEV_DONE__';

/** Where the bridge lives inside the guest. */
const AGENT_DIR = 'C:\\agent';
const RUN_PS1 = `${AGENT_DIR}\\run.ps1`;
const RUN_VBS = `${AGENT_DIR}\\run.vbs`;
const OUT_TXT = `${AGENT_DIR}\\out.txt`;
const TASK_NAME = 'jevrun';
const TASK_USER = 'Administrator';

/**
 * The one-time setup: create the folder, the hidden-launch VBS and the interactive task.
 * Idempotent — it re-creates the task on every call, which is what makes it survive a snapshot
 * rollback (the `init` snapshot has no `C:\agent` at all).
 * @returns {string} PowerShell.
 */
export function bootstrapScript() {
  return [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    `New-Item -ItemType Directory -Force -Path '${AGENT_DIR}' | Out-Null`,
    '$svc = New-Object -ComObject Schedule.Service',
    '$svc.Connect()',
    "$root = $svc.GetFolder('\\')",
    `try { $root.DeleteTask('${TASK_NAME}', 0) } catch {}`,
    '$td = $svc.NewTask(0)',
    '$td.Settings.Enabled = $true',
    '$td.Settings.AllowDemandStart = $true',
    "$td.Settings.ExecutionTimeLimit = 'PT10M'",
    '$td.Settings.DisallowStartIfOnBatteries = $false',
    '$td.Settings.StopIfGoingOnBatteries = $false',
    `$vbs = @('Set sh = CreateObject("WScript.Shell")', 'sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${RUN_PS1}", 0, True')`,
    `Set-Content -Path '${RUN_VBS}' -Encoding ASCII -Value $vbs`,
    '$action = $td.Actions.Create(0)',
    "$action.Path = 'C:\\Windows\\System32\\wscript.exe'",
    `$action.Arguments = '//B //Nologo ${RUN_VBS}'`,
    `$td.Principal.UserId = '${TASK_USER}'`,
    '$td.Principal.LogonType = 3', // TASK_LOGON_INTERACTIVE_TOKEN — session 1, not session 0
    '$td.Principal.RunLevel = 1',
    `$root.RegisterTaskDefinition('${TASK_NAME}', $td, 6, $null, $null, 3) | Out-Null`,
    // Right after a definition is (re)registered the engine can accept `Run()` and yet start no
    // instance (state 3, `GetInstances()` 0, no wscript process). A short settle makes the very
    // first run of a freshly rolled-back guest reliable; the runner also re-asks every 8 s.
    'Start-Sleep -Milliseconds 400',
    "Write-Output 'bridge-ready'",
    '',
  ].join('\r\n');
}

/**
 * Payload script for the guest: what `run.ps1` will contain.
 * @param {string} body the user script.
 * @returns {string} script that writes its own output file.
 */
export function payloadScript(body) {
  return [
    "$ErrorActionPreference='Continue'",
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    '$o = & {',
    String(body ?? ''),
    '} 2>&1 | Out-String',
    `[IO.File]::WriteAllText('${OUT_TXT}', $o + '${MARK}', [Text.Encoding]::UTF8)`,
  ].join('\r\n');
}

/**
 * The runner: write the payload, start the task, wait for the marker, hand the result back as
 * base64 (the agent would mangle any non-ASCII text).
 * @param {string} payloadB64 base64 of the UTF-8 payload **with BOM** (PowerShell reads it as UTF-8).
 * @param {number} iterations poll count (250 ms each).
 * @returns {string} PowerShell.
 */
export function runnerScript(payloadB64, iterations) {
  return [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    `[IO.File]::WriteAllBytes('${RUN_PS1}', [Convert]::FromBase64String('${payloadB64}'))`,
    `Remove-Item '${OUT_TXT}' -ErrorAction SilentlyContinue`,
    '$svc = New-Object -ComObject Schedule.Service',
    '$svc.Connect()',
    `$task = $svc.GetFolder('\\').GetTask('${TASK_NAME}')`,
    '$task.Run($null) | Out-Null',
    "$mark = '" + MARK + "'",
    "$done = $false",
    `for ($i = 0; $i -lt ${iterations}; $i++) {`,
    '  Start-Sleep -Milliseconds 250',
    '  if ($i -gt 0 -and ($i % 32) -eq 0) { try { $task.Run($null) | Out-Null } catch {} }',
    `  if (Test-Path '${OUT_TXT}') {`,
    `    $c = [IO.File]::ReadAllText('${OUT_TXT}')`,
    '    if ($c.Contains($mark)) { $done = $true; break }',
    '  }',
    '}',
    "if (-not $done) { Write-Output 'BRIDGE_TIMEOUT'; return }",
    `$raw = [IO.File]::ReadAllBytes('${OUT_TXT}')`,
    "Write-Output ('JEVB:' + [Convert]::ToBase64String($raw))",
    '',
  ].join('\r\n');
}

export class SessionBridge {
  /**
   * @param {{transport:object, settings:() => object}} deps wiring.
   */
  constructor(deps) {
    this.transport = deps.transport;
    this.settings = deps.settings;
    /** @type {Map<number, {node:string, at:number}>} */
    this.ready = new Map();
    /** @type {Map<number, Promise<void>>} serializes calls per VM (one run.ps1). */
    this.queues = new Map();
  }

  /**
   * Drop the readiness cache: after a rollback the guest is a different disk image.
   * @param {number} [vmid] a single VM, or every VM.
   */
  reset(vmid) {
    if (vmid === undefined) this.ready.clear();
    else this.ready.delete(Number(vmid));
  }

  /**
   * Run a script in session 1.
   * @param {{node:string, vmid:number, body:string, timeoutMs?:number, signal?:AbortSignal}} options call options.
   * @returns {Promise<{output:string, ms:number}>} the script's output.
   */
  async run(options) {
    const vmid = Number(options.vmid);
    const previous = this.queues.get(vmid) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.queues.set(
      vmid,
      previous.then(
        () => current,
        () => current,
      ),
    );
    try {
      await previous.catch(() => {});
      return await this.#run(options);
    } finally {
      release();
      if (this.queues.get(vmid) === current) this.queues.delete(vmid);
    }
  }

  /**
   * @private
   */
  async #run(options) {
    const settings = this.settings();
    const timeoutMs = options.timeoutMs ?? 60000;
    const cached = this.ready.get(options.vmid);
    if (cached === undefined || cached.node !== options.node) {
      const boot = await guestExec({
        transport: this.transport,
        node: options.node,
        vmid: options.vmid,
        script: bootstrapScript(),
        timeoutMs: 45000,
        signal: options.signal,
      });
      if (!boot.stdout.includes('bridge-ready')) {
        throw new VmError(
          'BRIDGE_FAILED',
          `the session-1 task could not be registered: ${(boot.stdout || boot.stderr).trim().slice(0, 500)}`,
        );
      }
      this.ready.set(options.vmid, { node: options.node, at: Date.now() });
    }
    const payload = `\ufeff${payloadScript(options.body)}`;
    const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
    const iterations = Math.max(8, Math.floor((timeoutMs - 8000) / 250));
    const started = Date.now();
    const result = await guestExec({
      transport: this.transport,
      node: options.node,
      vmid: options.vmid,
      script: runnerScript(payloadB64, iterations),
      timeoutMs: timeoutMs + 20000,
      signal: options.signal,
    });
    const text = result.stdout.trim();
    const match = /JEVB:([A-Za-z0-9+/=]+)/.exec(text);
    if (match === null) {
      if (text.includes('BRIDGE_TIMEOUT')) {
        throw new VmError(
          'BRIDGE_TIMEOUT',
          `no answer from the interactive session in ${Math.round(timeoutMs / 1000)} s — is an ` +
            'Administrator session still logged in on the console? Is a dialog covering the desktop?',
          { ms: Date.now() - started },
        );
      }
      throw new VmError(
        'BRIDGE_FAILED',
        `the bridge returned no payload: ${(text || result.stderr).trim().slice(0, 500)}`,
      );
    }
    const raw = Buffer.from(match[1], 'base64').toString('utf8');
    const bomless = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const output = bomless.endsWith(MARK) ? bomless.slice(0, -MARK.length) : bomless;
    this.ready.set(options.vmid, { node: options.node, at: Date.now() });
    return { output, ms: Date.now() - started };
  }
}
