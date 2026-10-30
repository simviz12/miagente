import { useEffect, useState, useSyncExternalStore } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { isSharing, startScreenShare, stopScreenShare, subscribe } from '../lib/screen'

/**
 * The machine, read live: processor, memory, battery and disk as rings, and the
 * time. The same numbers JARVIS speaks from pc_status, so what he says and what
 * the HUD shows can never disagree.
 *
 * Polled slowly on purpose. Each read is a PowerShell process on the bridge,
 * and a gauge that moves every few seconds already reads as alive.
 */

type System = {
  cpu: number
  memUsedGb: number
  memTotalGb: number
  battery: number | null
  charging: boolean | null
  diskFreeGb: number
  diskTotalGb: number
}

const POLL_MS = 6000

function useSystem() {
  const [sys, setSys] = useState<System | null>(null)
  useEffect(() => {
    let live = true
    const read = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/system`)
        const data = (await res.json()) as System | null
        if (live) setSys(data)
      } catch {
        /* the bridge is restarting; the last reading stays up until it is back */
      }
    }
    void read()
    const t = window.setInterval(read, POLL_MS)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [])
  return sys
}

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

const R = 19
const C = 2 * Math.PI * R

/** One ring. `warn` turns it red — a battery running out, a disk filling up. */
function Ring({ label, value, detail, warn }: { label: string; value: number | null; detail: string; warn?: boolean }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value))
  return (
    <div className={`gauge${warn ? ' gauge-warn' : ''}`}>
      <svg viewBox="0 0 48 48" className="gauge-ring" aria-hidden>
        <circle cx="24" cy="24" r={R} className="gauge-track" />
        <circle
          cx="24"
          cy="24"
          r={R}
          className="gauge-fill"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - v / 100)}
        />
        <text x="24" y="27.5" className="gauge-num">
          {value == null ? '--' : Math.round(v)}
        </text>
      </svg>
      <div className="gauge-text">
        <span className="gauge-label">{label}</span>
        <span className="gauge-detail">{detail}</span>
      </div>
    </div>
  )
}

export function Telemetry() {
  const sys = useSystem()
  const now = useClock()

  const mem = sys ? (sys.memUsedGb / sys.memTotalGb) * 100 : null
  const diskUsed = sys ? ((sys.diskTotalGb - sys.diskFreeGb) / sys.diskTotalGb) * 100 : null

  return (
    <div className="telemetry">
      <div className="clock">
        <span className="clock-time">
          {now.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
          <span className="clock-sec">{String(now.getSeconds()).padStart(2, '0')}</span>
        </span>
        <span className="clock-date">
          {now.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })}
        </span>
      </div>

      <div className="rail-title">SISTEMA</div>
      <Ring label="CPU" value={sys?.cpu ?? null} detail="procesador" warn={(sys?.cpu ?? 0) > 90} />
      <Ring
        label="RAM"
        value={mem}
        detail={sys ? `${sys.memUsedGb} / ${sys.memTotalGb} GB` : '—'}
        warn={(mem ?? 0) > 90}
      />
      {sys?.battery != null && (
        <Ring
          label="BAT"
          value={sys.battery}
          detail={sys.charging ? 'cargando' : 'batería'}
          warn={!sys.charging && sys.battery < 20}
        />
      )}
      <Ring
        label="DISCO"
        value={diskUsed}
        detail={sys ? `${sys.diskFreeGb} GB libres` : '—'}
        warn={(diskUsed ?? 0) > 92}
      />
    </div>
  )
}

/**
 * The switch for screen sharing. A button rather than a voice command because
 * the browser will only start a share from a real click — and because sharing
 * your screen is a decision worth making with your hand.
 */
export function ScreenButton() {
  const sharing = useSyncExternalStore(subscribe, isSharing)
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      className={`screen-btn${sharing ? ' on' : ''}${failed ? ' failed' : ''}`}
      onClick={() => {
        setFailed(false)
        if (sharing) stopScreenShare()
        else startScreenShare().catch(() => setFailed(true))
      }}
      title={sharing ? 'JARVIS puede ver tu pantalla. Clic para dejar de compartir.' : 'Compartir tu pantalla con JARVIS'}
    >
      <span className="screen-dot" />
      {sharing ? 'PANTALLA COMPARTIDA' : 'PANTALLA'}
    </button>
  )
}
