import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BRIDGE_HTTP_URL } from '../config'

/**
 * The to-do list, on the glass. JARVIS keeps it on the bridge (see
 * bridge/memory.mjs); this only reads it, so a task added or ticked off by
 * voice appears or leaves within a poll. Finished tasks stay a while, struck
 * through, because watching one cross off is half the point of saying "done".
 */

type Task = { id: number; text: string; done: boolean; due: string | null }
type Memory = { tasks: Task[]; clips: { id: number; label: string | null; preview: string }[] }

const POLL_MS = 2500
/** More than this and the rail runs into the transcript. */
const MAX_SHOWN = 7

export function Tasks() {
  const [mem, setMem] = useState<Memory | null>(null)

  useEffect(() => {
    let live = true
    const read = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/memory`)
        const data = (await res.json()) as Memory
        if (live) setMem(data)
      } catch {
        /* the bridge is restarting; keep showing the last list */
      }
    }
    void read()
    const t = window.setInterval(read, POLL_MS)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [])

  if (!mem) return null
  const pending = mem.tasks.filter((t) => !t.done)
  const done = mem.tasks.filter((t) => t.done).slice(-3)
  const shown = [...pending.slice(0, MAX_SHOWN), ...done].slice(0, MAX_SHOWN)

  return (
    <div className="tasks">
      <div className="rail-title">
        TAREAS <span className="tasks-count">{pending.length}</span>
      </div>
      {!shown.length && <div className="rail-item dim">di “apunta…”</div>}
      <AnimatePresence initial={false}>
        {shown.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={`task${t.done ? ' task-done' : ''}`}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <span className="task-box">{t.done ? '✓' : t.id}</span>
            <span className="task-text">
              {t.text}
              {t.due && !t.done && <span className="task-due">{t.due}</span>}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
      {pending.length > MAX_SHOWN && (
        <div className="rail-item dim">+{pending.length - MAX_SHOWN} más</div>
      )}
      {mem.clips.length > 0 && (
        <div className="rail-item dim clips-note">
          {mem.clips.length} guardado{mem.clips.length === 1 ? '' : 's'} en memoria
        </div>
      )}
    </div>
  )
}
