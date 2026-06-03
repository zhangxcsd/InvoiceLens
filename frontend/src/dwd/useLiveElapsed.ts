import { useEffect, useState } from 'react'

/** 有活动任务时每秒 tick，驱动「已运行」计时动态刷新。 */
export function useLiveElapsedTick(enabled: boolean): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return undefined
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [enabled])
  return tick
}

export function parseStartedAtMs(raw: string): number | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'))
  const ms = d.getTime()
  return Number.isNaN(ms) ? null : ms
}

export function liveElapsedMs(
  run: { started_at?: string; elapsed_ms?: number },
  _fetchedAtMs: number,
  tick: number,
): number {
  const fromStart = parseStartedAtMs(run.started_at ?? '')
  if (fromStart != null) {
    return Math.max(0, Date.now() - fromStart)
  }
  const base = Math.max(0, Number(run.elapsed_ms ?? 0))
  return base + tick * 1000
}
