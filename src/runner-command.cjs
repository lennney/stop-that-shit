'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsJobGuardPrelude() {
  const guardPath = Buffer.from(path.join(__dirname, 'windows-job-guard.cs'), 'utf8').toString('base64');
  return [
    `$jobPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${guardPath}'))`,
    '$jobReady = $false',
    'try { $jobSource = [IO.File]::ReadAllText($jobPath); Add-Type -TypeDefinition $jobSource -ErrorAction Stop | Out-Null; $jobReady = [StssRunnerJob]::AttachCurrentProcess() } catch { $jobReady = $false }',
    'if (-not $jobReady) { [Console]::Error.WriteLine("Stop That Shit: Windows process-tree containment is unavailable."); exit 1 }'
  ].join('; ');
}

function isShellNeutralWindowsPath(value) {
  return /^[A-Za-z]:\\[A-Za-z0-9_.~\\-]+$/.test(String(value || ''));
}

function sameWindowsPath(left, right) {
  return path.win32.normalize(left).replace(/\\+$/, '').toLowerCase()
    === path.win32.normalize(right).replace(/\\+$/, '').toLowerCase();
}

function getWindowsShortPath(powerShellPath) {
  const encodedPath = Buffer.from(powerShellPath, 'utf16le').toString('base64');
  const source = [
    "$native = 'using System; using System.Text; using System.Runtime.InteropServices; public static class StssPath { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint capacity); }'",
    'Add-Type -TypeDefinition $native',
    `$longPath = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    '$buffer = New-Object System.Text.StringBuilder 32768',
    '$length = [StssPath]::GetShortPathName($longPath, $buffer, [uint32]$buffer.Capacity)',
    'if ($length -eq 0 -or $length -ge $buffer.Capacity) { exit 5 }',
    '[Console]::Out.Write($buffer.ToString())'
  ].join('; ');
  const result = spawnSync(powerShellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], {
    encoding: 'utf8', windowsHide: true, timeout: 5000, shell: false
  });
  if (result.error || result.status !== 0) {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because Windows did not provide a usable short path.');
  }
  return String(result.stdout || '').trim();
}

function resolveWindowsPowerShell({ systemRoot = process.env.SystemRoot || process.env.WINDIR, fsApi = fs, shortPath = getWindowsShortPath } = {}) {
  if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because SystemRoot is not an absolute Windows path.');
  }
  let canonicalRoot;
  let canonicalPowerShell;
  try {
    canonicalRoot = fsApi.realpathSync(systemRoot);
    const candidate = path.win32.join(canonicalRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    canonicalPowerShell = fsApi.realpathSync(candidate);
    if (!fsApi.statSync(canonicalPowerShell).isFile()) throw new Error('not a file');
  } catch {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because the system PowerShell executable could not be verified under SystemRoot.');
  }
  const relative = path.win32.relative(canonicalRoot, canonicalPowerShell);
  if (!relative || relative === '..' || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because the PowerShell executable resolves outside SystemRoot.');
  }

  if (isShellNeutralWindowsPath(canonicalPowerShell)) return canonicalPowerShell;

  let short;
  try { short = shortPath(canonicalPowerShell); }
  catch { short = null; }
  if (!isShellNeutralWindowsPath(short)) {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because the system PowerShell path contains shell-sensitive characters and no usable short path exists.');
  }
  try {
    if (!sameWindowsPath(fsApi.realpathSync(short), canonicalPowerShell)) throw new Error('different file');
  } catch {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because the short path could not be verified as the system PowerShell executable.');
  }
  return short;
}

function buildRunnerCommand({ executable, runnerPath, sessionId, dataDir, ticket, agentId, platform = process.platform, windowsPowerShellPath } = {}) {
  const bootstrap = "require(Buffer.from(process.argv[1],'base64').toString('utf8')).run(Buffer.from(process.argv[2],'base64').toString('utf8'),Buffer.from(process.argv[3],'base64').toString('utf8'),process.argv[4],Buffer.from(process.argv[5]||'','base64').toString('utf8'))";
  const args = [executable, '-e', bootstrap, encode(runnerPath), encode(sessionId), encode(dataDir), ticket, encode(agentId || '')];

  if (platform === 'win32') {
    const script = `${windowsJobGuardPrelude()}; & ${args.map(quotePowerShell).join(' ')}; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE`;
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    // The absolute system path is either shell-neutral itself or a verified
    // 8.3 alias. No executable from PATH launches the approved runner.
    const powershell = windowsPowerShellPath || resolveWindowsPowerShell();
    if (!isShellNeutralWindowsPath(powershell)) throw new Error('A safe CMD/PowerShell launcher path is unavailable.');
    return `${powershell} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedScript}`;
  }

  return args.map(quotePosix).join(' ');
}

module.exports = { buildRunnerCommand, isShellNeutralWindowsPath, resolveWindowsPowerShell };
