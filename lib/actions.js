/**
 * Input scripts that run in session 1 (through {@link SessionBridge}).
 *
 * Two behaviours are deliberate and come from the playbook:
 *  • the pointer **moves before it clicks** (14 smoothstep steps, 18 ms each, then a 120 ms pause):
 *    a teleporting cursor makes Windows treat the press as a hover on some controls, and the click
 *    is silently lost;
 *  • nothing here assumes "one click = one page turn". Injected clicks are batched by the input
 *    stack, so one click can consume several queued events (playbook A-10: one click went three
 *    pages forward). Verification belongs to the caller — a screenshot, not an assumption.
 */

/** C# helper: cursor moves and button events, no UI Automation, no window handles. */
const JEV_INPUT_CS = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class JevInput {',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
  '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
  '}',
].join('\n');

/**
 * Script that moves the pointer and clicks.
 * @param {{x:number, y:number, button:'left'|'right'|'middle', clicks:number, doubleClick:boolean}} spec click spec.
 * @returns {string} PowerShell.
 */
export function clickScript(spec) {
  const down = { left: '0x0002', right: '0x0008', middle: '0x0020' }[spec.button] ?? '0x0002';
  const up = { left: '0x0004', right: '0x0010', middle: '0x0040' }[spec.button] ?? '0x0004';
  // `clicks` is optional: the wake-and-capture path clicks once without saying so. A missing value
  // used to become `NaN` here, and PowerShell then failed on `$c -lt NaN` — inside the hidden
  // session-1 window, so the only symptom was a 60 s bridge timeout.
  const requested = Number(spec.clicks ?? 1);
  const times = Number.isFinite(requested) ? Math.max(1, Math.min(3, Math.round(requested))) : 1;
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    `Add-Type -TypeDefinition @'\n${JEV_INPUT_CS}\n'@`,
    '[JevInput]::SetProcessDPIAware() | Out-Null',
    `$tx = ${Math.round(spec.x)}`,
    `$ty = ${Math.round(spec.y)}`,
    '$p = New-Object JevInput+POINT',
    '[JevInput]::GetCursorPos([ref]$p) | Out-Null',
    '$sx = $p.X',
    '$sy = $p.Y',
    'for ($i = 1; $i -le 14; $i++) {',
    '  $k = $i / 14.0',
    '  $k = $k * $k * (3 - 2 * $k)',
    '  [JevInput]::SetCursorPos([int]($sx + ($tx - $sx) * $k), [int]($sy + ($ty - $sy) * $k)) | Out-Null',
    '  Start-Sleep -Milliseconds 18',
    '}',
    'Start-Sleep -Milliseconds 120',
    `for ($c = 0; $c -lt ${times}; $c++) {`,
    `  [JevInput]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)`,
    '  Start-Sleep -Milliseconds 60',
    `  [JevInput]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)`,
    '  if ($c -lt ' + (times - 1) + ') { Start-Sleep -Milliseconds 90 }',
    '}',
    'Start-Sleep -Milliseconds 80',
    'Write-Output "clicked $tx,$ty with $([System.Windows.Forms.Cursor]::Position)"',
    '',
  ].join('\r\n');
}

/**
 * Quote text for a PowerShell single-quoted string.
 * @param {string} value text.
 * @returns {string} quoted literal.
 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Script that types text with SendKeys.
 *
 * SendKeys is the only injection point available in session 1 without a driver, and it has its own
 * grammar: `+` is Shift, `^` is Ctrl, `%` is Alt, braces are special. Text is therefore escaped, and
 * a newline becomes `{ENTER}` — typing a literal "\n" is not possible.
 * @param {{text:string, enter:boolean, delayMs:number}} spec typing spec.
 * @returns {string} PowerShell.
 */
export function typeScript(spec) {
  const escaped = String(spec.text ?? '')
    .replace(/[+^%~(){}[\]]/g, (char) => `{${char}}`)
    .replace(/\r\n/g, '{ENTER}')
    .replace(/[\r\n]/g, '{ENTER}')
    .replace(/\t/g, '{TAB}');
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.SendKeys]::SendWait(' + psQuote(escaped) + ')',
    spec.delayMs > 0 ? `Start-Sleep -Milliseconds ${spec.delayMs}` : '',
    spec.enter ? "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')" : '',
    'Write-Output "typed"',
    '',
  ]
    .filter((line) => line !== '')
    .join('\r\n');
}

/** Friendly key names → SendKeys tokens. */
const KEY_ALIASES = new Map([
  ['enter', '{ENTER}'],
  ['return', '{ENTER}'],
  ['tab', '{TAB}'],
  ['esc', '{ESC}'],
  ['escape', '{ESC}'],
  ['space', ' '],
  ['backspace', '{BACKSPACE}'],
  ['delete', '{DELETE}'],
  ['del', '{DELETE}'],
  ['insert', '{INSERT}'],
  ['home', '{HOME}'],
  ['end', '{END}'],
  ['pageup', '{PGUP}'],
  ['pagedown', '{PGDN}'],
  ['up', '{UP}'],
  ['down', '{DOWN}'],
  ['left', '{LEFT}'],
  ['right', '{RIGHT}'],
  ['f1', '{F1}'],
  ['f2', '{F2}'],
  ['f3', '{F3}'],
  ['f4', '{F4}'],
  ['f5', '{F5}'],
  ['f6', '{F6}'],
  ['f7', '{F7}'],
  ['f8', '{F8}'],
  ['f9', '{F9}'],
  ['f10', '{F10}'],
  ['f11', '{F11}'],
  ['f12', '{F12}'],
  ['win', '{LWIN}'],
  ['lwin', '{LWIN}'],
  ['apps', '{APPS}'],
  ['printscreen', '{PRTSC}'],
  ['prtsc', '{PRTSC}'],
  ['capslock', '{CAPSLOCK}'],
  ['numlock', '{NUMLOCK}'],
  ['scrolllock', '{SCROLLLOCK}'],
]);

/**
 * Translate a key expression into SendKeys.
 *
 * Accepted forms: a friendly name (`enter`, `f5`), a chord (`ctrl+a`, `alt+f4`, `ctrl+shift+esc`),
 * or a raw SendKeys expression passed through unchanged (`^a`, `%{F4}`, `{ENTER}`).
 * @param {string} expression the key expression.
 * @returns {string} SendKeys text.
 */
export function keyExpression(expression) {
  const raw = String(expression ?? '').trim();
  if (raw.length === 0) return '';
  const lower = raw.toLowerCase();
  const alias = KEY_ALIASES.get(lower);
  if (alias !== undefined) return alias;
  if (raw.startsWith('{') || /^[+^%]/.test(raw)) return raw;
  const parts = lower.split('+');
  if (parts.length > 1) {
    const modifier = parts.slice(0, -1);
    const key = parts[parts.length - 1];
    const prefix = modifier
      .map((mod) => {
        if (mod === 'ctrl' || mod === 'control') return '^';
        if (mod === 'alt') return '%';
        if (mod === 'shift') return '+';
        return '';
      })
      .join('');
    if (prefix.length > 0) {
      const token = KEY_ALIASES.get(key) ?? (key.length === 1 ? key : `{${key.toUpperCase()}}`);
      return prefix + token;
    }
  }
  return raw;
}

/**
 * Script that presses one key (or chord) `repeat` times.
 * @param {{keys:string, repeat:number, delayMs:number}} spec key spec.
 * @returns {string} PowerShell.
 */
export function keyScript(spec) {
  const lines = ['Add-Type -AssemblyName System.Windows.Forms'];
  for (let i = 0; i < Math.max(1, Math.min(50, spec.repeat)); i += 1) {
    lines.push('[System.Windows.Forms.SendKeys]::SendWait(' + psQuote(spec.keys) + ')');
    if (spec.delayMs > 0) lines.push(`Start-Sleep -Milliseconds ${spec.delayMs}`);
  }
  lines.push('Write-Output "pressed"');
  lines.push('');
  return lines.join('\r\n');
}
