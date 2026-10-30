/**
 * The user's screen, shared with JARVIS on their say-so.
 *
 * A browser will only start a screen share from a click — getDisplayMedia
 * demands a user gesture, and a voice command arriving over a WebSocket is not
 * one. That is the right rule, not an obstacle: so the share is switched on by
 * the PANTALLA button, the browser shows its own "sharing" bar for as long as it
 * is live, and JARVIS can take a frame from it whenever he is asked to look.
 *
 * Nothing is recorded. A frame is drawn, encoded, handed to the bridge for the
 * turn, and gone.
 */

let stream: MediaStream | null = null
let video: HTMLVideoElement | null = null
const listeners = new Set<() => void>()

const notify = () => listeners.forEach((fn) => fn())

export const isSharing = () => Boolean(stream)

/** For useSyncExternalStore: the button and the indicator follow the share. */
export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export async function startScreenShare(): Promise<void> {
  if (stream) return
  const s = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 2 },
    audio: false,
  })
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.srcObject = s
  await v.play()
  // The browser's own "stop sharing" button ends the track without asking us.
  s.getVideoTracks()[0]?.addEventListener('ended', stopScreenShare)
  stream = s
  video = v
  notify()
}

export function stopScreenShare() {
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  if (video) video.srcObject = null
  video = null
  notify()
}

/** 1280 wide is enough to read text and keeps the picture cheap to look at. */
const MAX_W = 1280

export async function grabScreen(): Promise<{ data: string; mimeType: string }> {
  if (!stream || !video?.videoWidth) {
    throw new Error(
      'Screen sharing is off. The user has to press the PANTALLA button once to share their screen.',
    )
  }
  const scale = Math.min(1, MAX_W / video.videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('could not draw the screen')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const url = canvas.toDataURL('image/jpeg', 0.75)
  return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/jpeg' }
}
