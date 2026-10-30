import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readClipboard, writeClipboard } from './pc.mjs'

/**
 * What JARVIS remembers for the user between conversations: their to-do list,
 * and things they asked him to keep — a clipboard with more than one slot.
 *
 * The agent's own memory is the conversation, and a conversation ends when the
 * page reloads. "What do I have to do today" has to survive that, so it lives
 * in one small JSON file in the user's home — outside the project, so a fresh
 * checkout or a reinstall never takes their list with it.
 *
 * Items carry short numbers because they are spoken: "done with task two" is
 * easy to say, an id is not. Numbers are never reused, so "two" can never come
 * to mean a different task halfway through a conversation.
 */

const DIR = join(homedir(), '.jarvis')
const FILE = join(DIR, 'memoria.json')

/** A saved clip longer than this is still kept whole; only the listing is cut. */
const PREVIEW = 120

function load() {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8'))
    return {
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      clips: Array.isArray(data.clips) ? data.clips : [],
      next: Number(data.next) || 1,
    }
  } catch {
    return { tasks: [], clips: [], next: 1 }
  }
}

/** Written to a temporary file and renamed over, so a crash mid-write can never leave half a list. */
function save(data) {
  mkdirSync(DIR, { recursive: true })
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, FILE)
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })

const norm = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()

/**
 * Find the item the user meant: by its number, or by any words of it.
 * Returns the item, or a string explaining why none (or too many) matched.
 */
function pick(items, ref, noun) {
  const n = Number(String(ref).replace(/\D+/g, ''))
  if (/^\D*\d+\D*$/.test(String(ref)) && n) {
    return items.find((i) => i.id === n) ?? `There is no ${noun} number ${n}.`
  }
  const q = norm(ref)
  const hits = items.filter((i) => norm(i.text + ' ' + (i.label ?? '')).includes(q))
  if (hits.length === 1) return hits[0]
  if (!hits.length) return `No ${noun} matches "${ref}".`
  return `Several ${noun}s match "${ref}": ${hits.map((i) => `${i.id} ${i.label ?? i.text}`).join('; ')}. Ask which one.`
}

const taskLine = (t) =>
  `${t.id}. ${t.text}${t.due ? ` (para: ${t.due})` : ''}${t.done ? ' [hecha]' : ''}`

const clipLine = (c) => {
  const body = c.text.length > PREVIEW ? `${c.text.slice(0, PREVIEW)}…` : c.text
  return `${c.id}. ${c.label ? `${c.label}: ` : ''}${body}`
}

/** For the HUD: the list as it stands, pending first. */
export function memorySnapshot() {
  const { tasks, clips } = load()
  return {
    tasks: [...tasks.filter((t) => !t.done), ...tasks.filter((t) => t.done)],
    clips: clips.map((c) => ({ id: c.id, label: c.label ?? null, preview: c.text.slice(0, 60) })),
  }
}

export function memoryServer() {
  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    instructions:
      "The user's own to-do list and saved clips. It persists between " +
      'conversations: when they ask what they have to do, read it — never answer from memory.',
    alwaysLoad: true,
    tools: [
      tool(
        'tasks_list',
        `The user's to-do list. Use it for "what do I have to do", "what is
pending", "read me my tasks". Pending tasks by default; set include_done to
also hear the finished ones.`,
        { include_done: z.boolean().optional().catch(undefined) },
        async ({ include_done }) => {
          const { tasks } = load()
          const shown = include_done ? tasks : tasks.filter((t) => !t.done)
          if (!shown.length) return text(include_done ? 'The list is empty.' : 'Nothing pending.')
          return text(shown.map(taskLine).join('\n'))
        },
      ),

      tool(
        'task_add',
        `Add tasks to the user's to-do list. One call can add several — "add
buy milk and call my mother" is two tasks. Keep each in their words, short.
If they say when, put it in due exactly as they said it ("mañana", "el viernes").`,
        {
          tasks: z.array(z.string()).min(1).describe('One entry per task.'),
          due: z.string().optional().catch(undefined).describe('When, as they said it. Applies to every task in this call.'),
        },
        async ({ tasks: items, due }) => {
          const data = load()
          const added = items
            .map((s) => s.trim())
            .filter(Boolean)
            .map((t) => ({ id: data.next++, text: t, done: false, due: due || null, created: new Date().toISOString() }))
          data.tasks.push(...added)
          save(data)
          const pending = data.tasks.filter((t) => !t.done).length
          return text(`Added: ${added.map(taskLine).join('; ')}. ${pending} pending in total.`)
        },
      ),

      tool(
        'task_done',
        `Mark a task finished — "I finished X", "done with task 2", "ya hice lo
del banco". Give its number or a few of its words.`,
        { task: z.string().describe('The task number, or words from it.') },
        async ({ task }) => {
          const data = load()
          const hit = pick(data.tasks.filter((t) => !t.done), task, 'pending task')
          if (typeof hit === 'string') return fail(hit)
          hit.done = true
          hit.doneAt = new Date().toISOString()
          save(data)
          const left = data.tasks.filter((t) => !t.done).length
          return text(`Done: ${hit.text}. ${left} still pending.`)
        },
      ),

      tool(
        'task_remove',
        'Take a task off the list entirely, done or not. For "delete", "forget", "quita".',
        { task: z.string().describe('The task number, or words from it.') },
        async ({ task }) => {
          const data = load()
          const hit = pick(data.tasks, task, 'task')
          if (typeof hit === 'string') return fail(hit)
          data.tasks = data.tasks.filter((t) => t !== hit)
          save(data)
          return text(`Removed: ${hit.text}.`)
        },
      ),

      tool(
        'tasks_clear_done',
        'Remove every finished task from the list, keeping the pending ones.',
        {},
        async () => {
          const data = load()
          const before = data.tasks.length
          data.tasks = data.tasks.filter((t) => !t.done)
          save(data)
          return text(`Cleared ${before - data.tasks.length} finished tasks.`)
        },
      ),

      tool(
        'clip_save',
        `Keep something for later — a clipboard with many slots. With no text, it
saves whatever is on the clipboard right now ("guarda lo que copié"). With
text, it saves that. Give a short label when they name it ("guárdalo como la
dirección") so it can be found by name later.`,
        {
          text: z.string().optional().catch(undefined).describe('What to keep. Leave out to save the current clipboard.'),
          label: z.string().optional().catch(undefined).describe('A short name for it.'),
        },
        async ({ text: given, label }) => {
          let body = given?.trim()
          if (!body) {
            try {
              body = (await readClipboard()).trim()
            } catch (err) {
              return fail(`The clipboard could not be read: ${err.message}.`)
            }
            if (!body) return fail('The clipboard is empty, there is nothing to save.')
          }
          const data = load()
          const clip = { id: data.next++, label: label?.trim() || null, text: body, saved: new Date().toISOString() }
          data.clips.push(clip)
          save(data)
          return text(`Saved as number ${clip.id}${clip.label ? `, "${clip.label}"` : ''}.`)
        },
      ),

      tool(
        'clip_list',
        'Everything saved with clip_save, numbered, with a preview of each.',
        {},
        async () => {
          const { clips } = load()
          return text(clips.length ? clips.map(clipLine).join('\n') : 'Nothing saved.')
        },
      ),

      tool(
        'clip_copy',
        `Put a saved item back on the clipboard, ready to paste — "dame la
dirección", "copia lo número tres". Also returns its full text, in case they
want it read out or used.`,
        { item: z.string().describe('Its number, label, or words from it.') },
        async ({ item }) => {
          const hit = pick(load().clips, item, 'saved item')
          if (typeof hit === 'string') return fail(hit)
          try {
            await writeClipboard(hit.text)
          } catch (err) {
            return fail(`The clipboard could not be written: ${err.message}.`)
          }
          return text(`On the clipboard now. Its text: ${hit.text}`)
        },
      ),

      tool(
        'clip_remove',
        'Delete a saved item.',
        { item: z.string().describe('Its number, label, or words from it.') },
        async ({ item }) => {
          const data = load()
          const hit = pick(data.clips, item, 'saved item')
          if (typeof hit === 'string') return fail(hit)
          data.clips = data.clips.filter((c) => c !== hit)
          save(data)
          return text(`Deleted ${hit.label ?? `number ${hit.id}`}.`)
        },
      ),
    ],
  })
}
