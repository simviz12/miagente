import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { mkdirSync, rm, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * JARVIS's hands on the computer itself.
 *
 * With write access on, the model can already reach the machine through Bash —
 * but on Windows that means guessing at PowerShell one-liners, and every wrong
 * guess is a failed turn and spent tokens. These are the handful of things a
 * voice assistant is actually asked to do on a desktop, each one a single call
 * that is known to work: open and close programs, the volume and the media
 * keys, a look at the screen, the state of the machine, the clipboard.
 *
 * Everything runs as one short PowerShell process per call. User input never
 * reaches the script text: it travels in environment variables, which the
 * script reads as plain strings, so a program called `x'; Remove-Item ...`
 * is just a program nobody has installed.
 *
 * Windows only. On anything else the server is not built at all.
 */

const CALL_TIMEOUT_MS = 20_000

/** Each call's script, deleted as soon as it finishes. */
const SCRIPT_DIR = join(tmpdir(), 'jarvis-pc')
let scriptSeq = 0

/**
 * Windows that belong to JARVIS itself. Closing them would take the assistant
 * down mid-sentence, so pc_close never matches them, whatever the model asks.
 */
const OWN_WINDOW = /^J\.A\.R\.V\.I\.S\.|^JARVIS \(cierra/

function ps(script, env = {}, timeout = CALL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    // A plain .ps1 run with -File. Not `-Command -`, because fed through stdin
    // PowerShell reads line by line and breaks every multi-line block; and not
    // -EncodedCommand, which Defender rightly treats as a malware signature and
    // blocks outright. The file is the ordinary, inspectable way to run a script.
    // UTF-8 output, or every accented app name ("Música") arrives mangled.
    const full =
      // Progress records ("Preparing modules for first use") also travel on
      // stderr; silenced here so they are never mistaken for a failure.
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ErrorActionPreference = "Stop"\n' +
      '$ProgressPreference = "SilentlyContinue"\n' +
      script
    mkdirSync(SCRIPT_DIR, { recursive: true })
    const file = join(SCRIPT_DIR, `${process.pid}-${++scriptSeq}.ps1`)
    // With a BOM, or Windows PowerShell reads the file as ANSI.
    writeFileSync(file, '﻿' + full, 'utf8')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { env: { ...process.env, ...env }, windowsHide: true },
    )
    child.on('close', () => rm(file, { force: true }, () => {}))
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, out, err: 'timed out' })
    }, timeout)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, out, err: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const msg = cleanErr(err)
      resolve({ ok: code === 0 && !msg, out: out.trim(), err: msg })
    })
  })
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })

/** Run a script and turn its outcome into a tool result in one line. */
async function run(script, env) {
  const r = await ps(script, env)
  if (!r.ok) return fail(firstLine(r.err) || 'The command failed.')
  return text(r.out || 'Done.')
}

/**
 * Errors from an encoded command can arrive as CLIXML, the serialised form
 * PowerShell uses between processes. Unwrap it to the human sentences.
 */
function cleanErr(raw) {
  const s = String(raw).trim()
  if (!s.includes('<Objs')) return s
  return [...s.matchAll(/<S S="Error">([^<]*)<\/S>/g)]
    .map((m) => m[1].replace(/_x000D__x000A_/g, '\n'))
    .join('')
    .trim()
}

/** PowerShell errors are paragraphs; the model only needs the sentence. */
const firstLine = (s) => String(s).split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''

/** The Core Audio volume control, compiled once per call (about half a second). */
const AUDIO = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class JarvisAudio {
  static IAudioEndpointVolume Vol() {
    var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume v = null;
    var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out v));
    return v;
  }
  public static float Level {
    get { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, Guid.Empty)); }
  }
  public static bool Muted {
    get { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, Guid.Empty)); }
  }
}
'@
`

/** Media keys, pressed the way a keyboard would press them. */
const KEYS = `
Add-Type -Name K -Namespace J -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, int e);'
function Press([byte]$k) { [J.K]::keybd_event($k, 0, 0, 0); [J.K]::keybd_event($k, 0, 2, 0) }
`

/**
 * The status read, shared with the HUD's /system endpoint so the gauges and
 * the spoken answer can never disagree.
 */
const STATUS = `
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
[pscustomobject]@{
  cpu = [int]$cpu
  memUsedGb = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 1)
  memTotalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  battery = if ($bat) { [int]$bat.EstimatedChargeRemaining } else { $null }
  charging = if ($bat) { $bat.BatteryStatus -eq 2 } else { $null }
  diskFreeGb = [math]::Round($disk.FreeSpace / 1GB, 1)
  diskTotalGb = [math]::Round($disk.Size / 1GB, 1)
  uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
} | ConvertTo-Json -Compress
`

/** The clipboard as text, or '' if it holds none. Throws if it cannot be read. */
export async function readClipboard() {
  const r = await ps(`$c = Get-Clipboard -Raw; if ($c) { $c }`)
  if (!r.ok) throw new Error(firstLine(r.err) || 'the clipboard could not be read')
  return r.out
}

/** Put text on the clipboard. Throws if it cannot be written. */
export async function writeClipboard(value) {
  const r = await ps(`Set-Clipboard -Value $env:JARVIS_TEXT`, { JARVIS_TEXT: value })
  if (!r.ok) throw new Error(firstLine(r.err) || 'the clipboard could not be written')
}

/** For the HUD: the same numbers pc_status speaks, as an object. Null if unreadable. */
export async function systemStatus() {
  if (process.platform !== 'win32') return null
  const r = await ps(STATUS)
  if (!r.ok) return null
  try {
    return JSON.parse(r.out)
  } catch {
    return null
  }
}

/**
 * @param {{ allowWrites: boolean, ask: (kind: string, args: object) => Promise<object> }} opts
 *   `ask` is the same browser request/reply channel the camera uses.
 */
export function pcServer({ allowWrites, ask }) {
  if (process.platform !== 'win32') return null

  const tools = [
    tool(
      'pc_status',
      `The state of the computer right now: processor load, memory, battery and
whether it is charging, free disk space on C:, and hours since it started.
Use it for "how is the computer", "battery", "how much space do I have",
"why is it slow".`,
      {},
      async () => {
        const s = await systemStatus()
        if (!s) return fail('The system status could not be read.')
        return text(JSON.stringify(s))
      },
    ),

    tool(
      'pc_apps',
      `The programs open on the desktop right now, one line each: process name and
window title. Use it before closing something whose exact name you do not
know, or for "what do I have open".`,
      {},
      async () =>
        run(`Get-Process | Where-Object { $_.MainWindowTitle } |
  ForEach-Object { "$($_.ProcessName) — $($_.MainWindowTitle)" }`),
    ),

    tool(
      'pc_screen',
      `Look at the user's screen: one frame of whatever they are sharing.

Use it when they ask about what is on their screen — "what is this error",
"read this", "what am I looking at", "help me with this".

It works only while they are sharing their screen with JARVIS, which they turn
on themselves with the PANTALLA button at the bottom of the interface — a
browser will not start screen sharing from a voice command. If it is off, tell
them to press PANTALLA once, and stop. Only when they ask: never speculatively.`,
      {},
      async () => {
        // Through the browser's own screen share rather than a screenshot taken
        // from here. A script that grabs the screen in the background is
        // exactly what spyware does, and Defender blocks it as such; the share
        // is chosen by the user, and the browser shows it is live.
        let reply
        try {
          reply = await ask('capture', { mode: 'screen' })
        } catch (err) {
          return fail(`Could not reach the interface: ${err?.message ?? err}.`)
        }
        if (reply?.error) return fail(String(reply.error))
        if (typeof reply?.data !== 'string' || !reply.data) return fail('The screen returned nothing.')
        return {
          content: [
            { type: 'text', text: "One frame of the user's screen:" },
            { type: 'image', data: reply.data, mimeType: reply.mimeType ?? 'image/jpeg' },
          ],
        }
      },
    ),

    tool(
      'pc_clipboard_read',
      'What is on the clipboard, as text. For "read what I copied", "translate this I copied".',
      {},
      async () => run(`$c = Get-Clipboard -Raw; if ($c) { $c } else { '(the clipboard is empty)' }`),
    ),
  ]

  // Everything below changes something on the machine, so it exists only with
  // write access on — the same rule the browser's acting tools follow.
  if (allowWrites) {
    tools.push(
      tool(
        'pc_open',
        `Open a program, a website, a folder or a file on the user's computer.

Give the program the way the user said it — "Spotify", "calculadora", "bloc de
notas", "Word". It is matched against the Start menu, so localised names work.
A URL opens in the default browser, a path opens in its program, and a folder
opens in Explorer. Known folders work by name too: Descargas, Documentos,
Escritorio, Imágenes, Música, Vídeos.

If nothing matches, the closest names installed are returned: say them once as
a question, do not guess.`,
        { target: z.string().describe('Program name, URL, folder name or full path.') },
        async ({ target }) => {
          const r = await ps(
            `
$q = $env:JARVIS_Q.Trim()
$folders = @{
  'descargas'='Downloads'; 'downloads'='Downloads'
  'documentos'='MyDocuments'; 'documents'='MyDocuments'
  'escritorio'='Desktop'; 'desktop'='Desktop'
  'imagenes'='MyPictures'; 'imágenes'='MyPictures'; 'pictures'='MyPictures'; 'fotos'='MyPictures'
  'musica'='MyMusic'; 'música'='MyMusic'; 'music'='MyMusic'
  'videos'='MyVideos'; 'vídeos'='MyVideos'
}
$key = $q.ToLower()
if ($folders.ContainsKey($key)) {
  if ($folders[$key] -eq 'Downloads') { $path = Join-Path $env:USERPROFILE 'Downloads' }
  else { $path = [Environment]::GetFolderPath($folders[$key]) }
  Start-Process explorer.exe $path; "Opened the folder $path"; return
}
if ($q -match '^(https?://|www\\.)') {
  if ($q -notmatch '^https?://') { $q = "https://$q" }
  Start-Process $q; "Opened $q"; return
}
if (Test-Path -LiteralPath $q) { Invoke-Item -LiteralPath $q; "Opened $q"; return }
$apps = Get-StartApps
$hit = $apps | Where-Object { $_.Name -eq $q } | Select-Object -First 1
if (-not $hit) {
  $hit = $apps | Where-Object { $_.Name -like "*$q*" } | Sort-Object { $_.Name.Length } | Select-Object -First 1
}
if ($hit) { Start-Process explorer.exe "shell:AppsFolder\\$($hit.AppID)"; "Opened $($hit.Name)"; return }
try { Start-Process $q -ErrorAction Stop; "Opened $q"; return } catch {}
$words = $q -split '\\s+' | Where-Object { $_.Length -ge 3 }
$near = $apps | Where-Object { $n = $_.Name; $words | Where-Object { $n -like "*$_*" } } |
  Select-Object -First 5 -ExpandProperty Name
if ($near) { throw "Nothing called '$q' is installed. Closest: $($near -join ', ')." }
throw "Nothing called '$q' is installed."`,
            { JARVIS_Q: target },
          )
          return r.ok ? text(r.out) : fail(firstLine(r.err))
        },
      ),

      tool(
        'pc_close',
        `Close a program that is open on the desktop, matched by process name or
window title ("chrome", "Spotify", "calculadora"). It asks the window to close,
the way clicking its X does, so unsaved work still gets its "save changes?"
prompt. Set force only when the user says it is frozen. JARVIS's own windows
are never closed.`,
        {
          target: z.string().describe('Process name or part of the window title.'),
          force: z.boolean().optional().catch(undefined).describe('Kill it outright. Only for a frozen program.'),
        },
        async ({ target, force }) => {
          const r = await ps(
            `
$q = $env:JARVIS_Q.Trim()
$own = '${OWN_WINDOW.source.replace(/'/g, "''")}'
$p = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -notmatch $own -and
  ($_.ProcessName -like "*$q*" -or $_.MainWindowTitle -like "*$q*")
}
if (-not $p) { throw "No open window matches '$q'." }
foreach ($x in $p) {
  if ($env:JARVIS_FORCE -eq '1') { Stop-Process -Id $x.Id -Force } else { [void]$x.CloseMainWindow() }
}
"Closed: $(($p | ForEach-Object { $_.MainWindowTitle }) -join ', ')"`,
            { JARVIS_Q: target, JARVIS_FORCE: force ? '1' : '0' },
          )
          return r.ok ? text(r.out) : fail(firstLine(r.err))
        },
      ),

      tool(
        'pc_volume',
        `The computer's sound. Set an exact level, step it up or down, or mute.
Always reports the level it ended at.`,
        {
          action: z.enum(['set', 'up', 'down', 'mute', 'unmute', 'get']),
          level: z
            .union([z.number(), z.string()])
            .optional()
            .catch(undefined)
            .describe('0 to 100. For set it is the level; for up and down the step (default 10).'),
        },
        async ({ action, level }) =>
          run(
            `${AUDIO}
$n = [double]$env:JARVIS_LEVEL
$cur = [JarvisAudio]::Level * 100
switch ($env:JARVIS_ACTION) {
  'set'    { [JarvisAudio]::Level = [math]::Max(0, [math]::Min(100, $n)) / 100; [JarvisAudio]::Muted = $false }
  'up'     { [JarvisAudio]::Level = [math]::Min(100, $cur + $(if ($n) { $n } else { 10 })) / 100; [JarvisAudio]::Muted = $false }
  'down'   { [JarvisAudio]::Level = [math]::Max(0, $cur - $(if ($n) { $n } else { 10 })) / 100 }
  'mute'   { [JarvisAudio]::Muted = $true }
  'unmute' { [JarvisAudio]::Muted = $false }
}
"Volume $([math]::Round([JarvisAudio]::Level * 100))%$(if ([JarvisAudio]::Muted) { ', muted' })"`,
            { JARVIS_ACTION: action, JARVIS_LEVEL: String(Number(level) || 0) },
          ),
      ),

      tool(
        'pc_media',
        `The media keys, for whatever is playing — Spotify, YouTube, any player:
play or pause, next track, previous track, stop.`,
        { action: z.enum(['play_pause', 'next', 'previous', 'stop']) },
        async ({ action }) => {
          const vk = { play_pause: 0xb3, next: 0xb0, previous: 0xb1, stop: 0xb2 }[action]
          return run(`${KEYS}\nPress ${vk}\n'Done.'`)
        },
      ),

      tool(
        'pc_clipboard_write',
        'Put text on the clipboard, ready for the user to paste. For "copy that for me".',
        { text: z.string() },
        async ({ text: value }) =>
          run(`Set-Clipboard -Value $env:JARVIS_TEXT; 'Copied to the clipboard.'`, { JARVIS_TEXT: value }),
      ),

      tool(
        'pc_lock',
        'Lock the computer, as Windows+L does. Only when the user asks.',
        {},
        async () => run(`rundll32.exe user32.dll,LockWorkStation; 'Locked.'`),
      ),
    )
  }

  return createSdkMcpServer({
    name: 'jarvis_pc',
    version: '1.0.0',
    instructions:
      "The user's own Windows computer: programs, sound, media keys, screen, " +
      'clipboard, status. Reach for these before Bash for anything they cover.',
    // A voice request like "turn it down" has to find this without a search step.
    alwaysLoad: true,
    tools,
  })
}
