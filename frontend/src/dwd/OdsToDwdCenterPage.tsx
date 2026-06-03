import { Fragment, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchOdsPreviewBatches,
  odsPreviewBatchKey,
  postDwdBuild,
  postDwdForceRebuild,
  type DwdBuildResult,
  type OdsPreviewBatchMeta,
} from '../config/localApi'

type DwdStatus = 'not_built' | 'running' | 'succeeded' | 'failed'

type DwdBatchRow = {
  batchId: string
  // 聚合：该批次下会话
  sessions: OdsPreviewBatchMeta[]
  odsParquetPathCount: number
  odsFileCount: number
  successCount: number
  failCount: number
  warnCount: number
  latestLoadTime: string

  // DWD：默认来自 DuckDB 汇总；本页构建完成后可由 buildByBatch 覆盖
  dwdStatus: DwdStatus
  updatedAt: string
  /** 展示用：优先 ods_load_log.total_rows 聚合，否则为占位估算 */
  estRows: number
  dwdRows: number | null
  durationLabel: string
}

function formatLoadTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19).replace('T', ' ')
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${da} ${h}:${mi}`
}

/** 将 run_cleaner 返回的 dq_* 摘要写入构建日志（专项行数 + 金额/detail_uuid 对账） */
function buildDqCleanerLogLines(cl: Record<string, unknown>): string[] {
  const labels = t.odsToDwdCenterUi.dqReportLabels as Record<string, string>
  const flagged: string[] = []
  for (const [key, label] of Object.entries(labels)) {
    const v = cl[key]
    if (Array.isArray(v) && v.length > 0) {
      flagged.push(`  · ${label}：${v.length} 条`)
    }
  }
  if (flagged.length === 0) {
    return [`  · ${t.odsToDwdCenterUi.dqReportAllOk}`]
  }
  return [t.odsToDwdCenterUi.dqReportSectionTitle, ...flagged]
}

function formatLocalDateTime(ts = new Date()): string {
  const d = ts
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const se = String(d.getSeconds()).padStart(2, '0')
  return `${y}-${mo}-${da} ${h}:${mi}:${se}`
}

function statusBadge(status: DwdStatus): { text: string; cls: string } {
  if (status === 'running') return { text: t.odsToDwdCenterUi.badgeRunning, cls: 'border-[#c8dff7] bg-[#f0f7ff] text-accent-mid' }
  if (status === 'succeeded') return { text: t.odsToDwdCenterUi.badgeSucceeded, cls: 'border-[#b7e4c8] bg-[#f0fdf4] text-[#0d5c2e]' }
  if (status === 'failed') return { text: t.odsToDwdCenterUi.badgeFailed, cls: 'border-danger/30 bg-[#fff5f5] text-danger' }
  return { text: t.odsToDwdCenterUi.badgeNotBuilt, cls: 'border-[#f2c078] bg-[#fff7ea] text-[#9a5a00] font-semibold' }
}

type BatchBuildOverlay = {
  dwdStatus: DwdStatus
  dwdRows: number | null
  durationLabel: string
  errorMsg?: string
  steps?: { id: string; label: string; status: string; detail?: string }[]
  logText?: string
  statYear?: string | number
}

/** 将 DWD 响应中的 enterprise_year_rel_rebuild 摘要追加到构建日志 */
function formatEnterpriseYearRelRebuildLog(rel: unknown): string[] {
  if (rel == null || typeof rel !== 'object') return []
  const o = rel as Record<string, unknown>
  if (o.skipped === true) {
    const msg = o.message != null ? String(o.message) : ''
    return msg.trim() ? [`企业年度购销关系：跳过（${msg}）`] : ['企业年度购销关系：跳过']
  }
  if (o.ok === false) {
    const err = o.error
    const msg =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message?: unknown }).message ?? '')
        : String(o.error ?? '未知错误')
    return [`企业年度购销关系重算失败：${msg || '—'}`]
  }
  if (o.ok === true && o.dry_run === true) {
    return [`企业年度购销关系：预演（dry_run）将写入约 ${String(o.rows_that_would_insert ?? '—')} 行`]
  }
  if (o.ok === true) {
    const years = Array.isArray(o.stat_years) ? o.stat_years.map(String).join('、') : '—'
    return [
      `企业年度购销关系：已重算 年度=[${years}]，写入后行数=${String(o.rows_after_insert ?? '—')}（删前=${String(o.rows_before_delete ?? '—')}）`,
    ]
  }
  return []
}

function aggregateToDwdRows(list: OdsPreviewBatchMeta[]): DwdBatchRow[] {
  const by: Record<string, OdsPreviewBatchMeta[]> = {}
  for (const m of list) {
    const b = String(m.batch_id ?? '').trim()
    if (!b) continue
    if (!by[b]) by[b] = []
    by[b].push(m)
  }
  const out: DwdBatchRow[] = []
  for (const [batchId, rows] of Object.entries(by)) {
    const sorted = [...rows].sort((a, b) => String(b.load_time ?? '').localeCompare(String(a.load_time ?? ''), 'zh-CN'))
    const latest = String(sorted[0]?.load_time ?? '')
    const odsFileCount = rows.reduce((s, x) => s + Number(x.file_count ?? 0), 0)
    const odsParquetPathCount = rows.reduce((s, x) => s + Number(x.parquet_path_count ?? 0), 0)
    const successCount = rows.reduce((s, x) => s + Number(x.success_count ?? 0), 0)
    const failCount = rows.reduce((s, x) => s + Number(x.fail_count ?? 0), 0)
    const warnCount = rows.reduce((s, x) => s + Number(x.warn_count ?? 0), 0)
    const fromLog = rows.reduce((s, x) => s + Math.max(0, Number(x.total_rows ?? 0)), 0)
    const estRows =
      fromLog > 0
        ? fromLog
        : Math.max(0, odsParquetPathCount * 1800 + odsFileCount * 60)
    const dwdHdr = rows.reduce((s, x) => s + Number(x.dwd_header_rows ?? 0), 0)
    const dwdDtl = rows.reduce((s, x) => s + Number(x.dwd_detail_rows ?? 0), 0)
    const dwdTotal = dwdHdr + dwdDtl
    const st: DwdStatus = dwdTotal > 0 ? 'succeeded' : 'not_built'
    const dwdRows = dwdTotal > 0 ? dwdTotal : null
    out.push({
      batchId,
      sessions: sorted,
      odsParquetPathCount,
      odsFileCount,
      successCount,
      failCount,
      warnCount,
      latestLoadTime: latest,
      dwdStatus: st,
      updatedAt: latest,
      estRows,
      dwdRows,
      durationLabel: '—',
    })
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt), 'zh-CN'))
  return out
}

function sessionIdsInBatch(row: DwdBatchRow): string[] {
  return row.sessions.map((s) => String(s.session_id ?? '').trim()).filter(Boolean)
}

export function OdsToDwdCenterPage() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [list, setList] = useState<OdsPreviewBatchMeta[]>([])
  const [building, setBuilding] = useState(false)
  const [buildByBatch, setBuildByBatch] = useState<Record<string, BatchBuildOverlay>>({})

  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | DwdStatus>('not_built')
  const [selectedBatchId, setSelectedBatchId] = useState<string>('')
  const [activeTab, setActiveTab] = useState<'logs' | 'metrics'>('logs')
  /** 批量增量：batch_id → 勾选的 import_session_id（同一批次可多选） */
  const [bulkPick, setBulkPick] = useState<Record<string, string[]>>({})
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null)
  const [bulkProgressLabel, setBulkProgressLabel] = useState<string | null>(null)
  /** 与 POST /api/dwd/build 的 rebuild_enterprise_year_rel 对齐；单次与批量增量构建共用 */
  const [rebuildEnterpriseYearRelAfterDwd, setRebuildEnterpriseYearRelAfterDwd] = useState(false)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    void (async () => {
      setBusy(true)
      setError(null)
      try {
        const r = await fetchOdsPreviewBatches(ac.signal, 120)
        if (cancelled) return
        if (!r.ok) {
          setList([])
          setError(r.error?.message ?? r.error?.detail ?? '无法加载批次列表')
          return
        }
        setList(r.batches ?? [])
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [])

  const rows = useMemo(() => {
    const base = aggregateToDwdRows(list)
    return base.map((r) => {
      const o = buildByBatch[r.batchId]
      if (!o) return r
      return {
        ...r,
        dwdStatus: o.dwdStatus,
        dwdRows: o.dwdRows,
        durationLabel: o.durationLabel,
      }
    })
  }, [list, buildByBatch])

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (status !== 'all' && r.dwdStatus !== status) return false
      if (!qq) return true
      return r.batchId.toLowerCase().includes(qq)
    })
  }, [rows, q, status])

  useEffect(() => {
    if (filtered.length === 0) return
    if (!selectedBatchId || !filtered.some((r) => r.batchId === selectedBatchId)) {
      setSelectedBatchId(filtered[0]!.batchId)
    }
  }, [filtered, selectedBatchId])

  const current = useMemo(() => filtered.find((r) => r.batchId === selectedBatchId) ?? null, [filtered, selectedBatchId])

  const reloadBatches = async () => {
    try {
      const r = await fetchOdsPreviewBatches(undefined, 120)
      if (r.ok) setList(r.batches ?? [])
    } catch {
      /* 忽略刷新失败 */
    }
  }

  const bulkStats = useMemo(() => {
    const jobs = Object.entries(bulkPick).filter(([, ids]) => ids.length > 0)
    return {
      jobs,
      batchN: jobs.length,
      sessN: jobs.reduce((a, [, ids]) => a + ids.length, 0),
    }
  }, [bulkPick])

  const allFilteredBulkOn =
    filtered.length > 0 &&
    filtered.every((r) => {
      const all = sessionIdsInBatch(r)
      const cur = bulkPick[r.batchId] ?? []
      return all.length > 0 && all.every((id) => cur.includes(id))
    })
  const someFilteredBulkOn =
    filtered.some((r) => (bulkPick[r.batchId] ?? []).length > 0) && !allFilteredBulkOn

  const badge = statusBadge(current?.dwdStatus ?? 'not_built')
  const buildDetail = current ? buildByBatch[current.batchId] : undefined

  const applyDwdResult = (
    batchId: string,
    r: DwdBuildResult & { httpStatus: number; force_rebuild?: boolean; import_session_id?: string },
    t0: number,
    opts?: { skipReload?: boolean },
  ) => {
    const ms = Date.now() - t0
    const dur =
      ms < 1000
        ? `${Math.round(ms / 100) / 10}s`
        : `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
    if (r.ok) {
      const cl = (r.cleaner ?? {}) as Record<string, unknown>
      const skipped = String(r.stat_year_source ?? '') === 'skipped_incremental_empty'
      const hdr = Number(cl.rows_written_header ?? 0)
      const dtl = Number(cl.rows_written_detail ?? 0)
      const dwdRows = hdr + dtl
      const warn = String(cl.status ?? '') === 'warning'
      const scannedHdr = Number(cl.rows_scanned_header ?? 0)
      const scannedDtl = Number(cl.rows_scanned_detail ?? 0)
      const rejN = Number(cl.rows_rejected ?? 0)
      const yearsLabel =
        Array.isArray(r.stat_years_built) && r.stat_years_built.length > 0
          ? r.stat_years_built.join('、')
          : r.stat_year != null
            ? String(r.stat_year)
            : '—'
      const ts = formatLocalDateTime()
      const sid = r.import_session_id != null ? String(r.import_session_id) : ''
      const forceNote = r.force_rebuild && sid ? ` · 强制重洗 import_session_id=${sid}` : ''
      const logLines = skipped
        ? [
            `${ts} · 增量构建${forceNote}`,
            String(r.message ?? ''),
            `stat_year_source=${r.stat_year_source}`,
            ...formatEnterpriseYearRelRebuildLog(
              'enterprise_year_rel_rebuild' in r
                ? (r as { enterprise_year_rel_rebuild?: unknown }).enterprise_year_rel_rebuild
                : undefined,
            ),
          ]
            .filter((x) => String(x).trim().length > 0)
            .join('\n')
        : [
              `${ts} · stat_year=[${yearsLabel}]（来源：${r.stat_year_source}）${forceNote}`,
              `ODS 扫描：header 口径 ${scannedHdr.toLocaleString('zh-CN')} 行，detail 口径 ${scannedDtl.toLocaleString('zh-CN')} 行；header 拒收 ${rejN.toLocaleString('zh-CN')} 行（可与上数对照）`,
              ...(r.steps ?? []).map((s) => `  [${s.id}] ${s.status} — ${s.detail ?? ''}`),
              String(cl.message ?? ''),
              warn ? '提示：存在 header 拒收行，详见 cleaner.reject_row_samples / 日志' : '',
              ...buildDqCleanerLogLines(cl),
              ...formatEnterpriseYearRelRebuildLog(
                'enterprise_year_rel_rebuild' in r ? (r as { enterprise_year_rel_rebuild?: unknown }).enterprise_year_rel_rebuild : undefined,
              ),
            ]
              .filter((x) => String(x).trim().length > 0)
              .join('\n')
      setBuildByBatch((prev) => ({
        ...prev,
        [batchId]: {
          dwdStatus: 'succeeded',
          dwdRows,
          durationLabel: dur,
          steps: r.steps,
          logText: logLines,
          statYear: yearsLabel,
        },
      }))
      if (!opts?.skipReload) void reloadBatches()
    } else {
      const st = Number(r.httpStatus ?? 0)
      const msg =
        r.error?.message ??
        (st === 502 || st === 503
          ? t.odsToDwdCenterUi.httpErrorProxy502.replace('{status}', String(st))
          : `操作失败（HTTP ${st || '—'}）`)
      const logLines = [
        `${formatLocalDateTime()} · error`,
        r.error?.detail ?? '',
        msg,
      ]
        .filter((x) => String(x).trim().length > 0)
        .join('\n')
      setBuildByBatch((prev) => ({
        ...prev,
        [batchId]: {
          dwdStatus: 'failed',
          dwdRows: null,
          durationLabel: dur,
          errorMsg: msg,
          logText: logLines,
        },
      }))
      setError(msg)
    }
  }

  const runFullBuild = async () => {
    if (!current || building) return
    setBuilding(true)
    setError(null)
    const t0 = Date.now()
    setBuildByBatch((prev) => {
      const old = prev[current.batchId]
      return {
        ...prev,
        [current.batchId]: {
          dwdStatus: 'running',
          dwdRows: old?.dwdRows ?? null,
          durationLabel: '—',
          errorMsg: undefined,
          logText: `${formatLocalDateTime()} · 开始增量构建`,
        },
      }
    })
    try {
      const r = await postDwdBuild({
        import_batch_id: current.batchId,
        ...(rebuildEnterpriseYearRelAfterDwd ? { rebuild_enterprise_year_rel: true } : {}),
      })
      applyDwdResult(current.batchId, r, t0)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      if (current) {
        setBuildByBatch((prev) => ({
          ...prev,
          [current.batchId]: {
            dwdStatus: 'failed',
            dwdRows: null,
            durationLabel: '—',
            errorMsg: msg,
            logText: msg,
          },
        }))
      }
    } finally {
      setBuilding(false)
    }
  }

  const runForceRebuildForSession = async (batchId: string, sessionId: string) => {
    const bid = String(batchId ?? '').trim()
    const sid = String(sessionId ?? '').trim()
    if (building || !bid || !sid) return
    if (!window.confirm(t.odsToDwdCenterUi.forceRebuildConfirm)) return
    setBuilding(true)
    setError(null)
    const t0 = Date.now()
    setBuildByBatch((prev) => {
      const old = prev[bid]
      return {
        ...prev,
        [bid]: {
          dwdStatus: 'running',
          dwdRows: old?.dwdRows ?? null,
          durationLabel: '—',
          errorMsg: undefined,
          logText: `${formatLocalDateTime()} · 开始强制重洗 import_session_id=${sid}`,
        },
      }
    })
    try {
      const r = await postDwdForceRebuild({
        import_batch_id: bid,
        import_session_id: sid,
        ...(rebuildEnterpriseYearRelAfterDwd ? { rebuild_enterprise_year_rel: true } : {}),
      })
      applyDwdResult(bid, r, t0)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setBuildByBatch((prev) => ({
        ...prev,
        [bid]: {
          dwdStatus: 'failed',
          dwdRows: null,
          durationLabel: '—',
          errorMsg: msg,
          logText: msg,
        },
      }))
    } finally {
      setBuilding(false)
    }
  }

  const selectAllFilteredForBulk = () => {
    const n: Record<string, string[]> = {}
    for (const r of filtered) {
      const ids = sessionIdsInBatch(r)
      if (ids.length) n[r.batchId] = ids
    }
    setBulkPick(n)
  }

  const clearBulkPickAll = () => setBulkPick({})

  const runBulkIncremental = async () => {
    if (building || bulkStats.batchN === 0) return
    setBuilding(true)
    setError(null)
    setBulkProgressLabel(`0/${bulkStats.batchN}`)
    try {
      for (let j = 0; j < bulkStats.jobs.length; j++) {
        const [batchId, ids] = bulkStats.jobs[j]!
        setBulkProgressLabel(`${j + 1}/${bulkStats.batchN} · ${batchId}`)
        setBuildByBatch((prev) => {
          const old = prev[batchId]
          return {
            ...prev,
            [batchId]: {
              dwdStatus: 'running',
              dwdRows: old?.dwdRows ?? null,
              durationLabel: '—',
              errorMsg: undefined,
              logText: `${formatLocalDateTime()} · 批量增量构建中 (${j + 1}/${bulkStats.batchN})`,
            },
          }
        })
        const row = rows.find((x) => x.batchId === batchId)
        const allIds = row ? sessionIdsInBatch(row) : ids
        const useFilter = ids.length > 0 && ids.length < allIds.length
        const t0 = Date.now()
        const r = await postDwdBuild({
          import_batch_id: batchId,
          incremental: true,
          ...(useFilter ? { import_session_ids: ids } : {}),
          ...(rebuildEnterpriseYearRelAfterDwd ? { rebuild_enterprise_year_rel: true } : {}),
        })
        applyDwdResult(batchId, r, t0, { skipReload: true })
        if (!r.ok) {
          // applyDwdResult 已 setError（含 HTTP 502 网关说明）；无 message 时再补批量前缀
          if (!r.error?.message) {
            const st = Number(r.httpStatus ?? 0)
            if (st !== 502 && st !== 503) {
              setError(`${t.odsToDwdCenterUi.bulkIncrementalFailPrefix}${batchId}`)
            }
          }
          break
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      void reloadBatches()
      setBulkProgressLabel(null)
      setBuilding(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-[22px]">
      <div className="mb-4 flex min-h-0 shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-il-page-title font-semibold text-text">{t.odsToDwdCenterUi.pageTitle}</span>
          </div>
          <p className="w-full text-il-page-desc leading-relaxed text-text-2">{t.odsToDwdCenterUi.pageBody}</p>
          {error ? (
            <p className="mt-2 w-full rounded-[7px] border border-danger/30 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={busy}
          className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
          onClick={() => window.location.reload()}
        >
          {busy ? t.odsToDwdCenterUi.refreshing : t.odsToDwdCenterUi.refresh}
        </button>
      </div>

      {rows.length === 0 ? (
        <Card title={t.odsToDwdCenterUi.emptyCardTitle} className="shrink-0">
          <p className="text-il-page-desc text-text-3">{t.odsToDwdCenterUi.emptyBody}</p>
        </Card>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <Card
            title={t.odsToDwdCenterUi.listCardTitle}
            className="min-h-0"
            bodyClassName="min-h-0 flex flex-col overflow-hidden !p-0"
          >
            <div className="shrink-0 border-b border-border-light px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t.odsToDwdCenterUi.searchPlaceholder}
                  className="min-w-[12rem] flex-1 rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-1.5 text-il-input text-text outline-none focus:border-accent sm:max-w-md"
                />
                <select
                  value={status}
                  onChange={(e) => setStatus((e.target.value as any) || 'not_built')}
                  className="min-w-[10rem] rounded-[7px] border border-border bg-[#fafbfc] px-2 py-1.5 text-il-input text-text outline-none focus:border-accent"
                >
                  <option value="all">{t.odsToDwdCenterUi.statusAll}</option>
                  <option value="not_built">{t.odsToDwdCenterUi.statusNotBuilt}</option>
                  <option value="running">{t.odsToDwdCenterUi.statusRunning}</option>
                  <option value="succeeded">{t.odsToDwdCenterUi.statusSucceeded}</option>
                  <option value="failed">{t.odsToDwdCenterUi.statusFailed}</option>
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-light bg-[#f9fbfd] px-4 py-2.5 text-[12px] text-text-2">
                <label className="inline-flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allFilteredBulkOn}
                    ref={(el) => {
                      if (el) el.indeterminate = someFilteredBulkOn
                    }}
                    disabled={building || filtered.length === 0}
                    onChange={(e) => {
                      if (e.target.checked) selectAllFilteredForBulk()
                      else clearBulkPickAll()
                    }}
                  />
                  <span>{t.odsToDwdCenterUi.bulkSelectAllFiltered}</span>
                </label>
                <button
                  type="button"
                  disabled={building}
                  className="rounded-[6px] border border-border bg-white px-2.5 py-1 text-[12px] hover:border-accent hover:text-accent disabled:opacity-50"
                  onClick={() => clearBulkPickAll()}
                >
                  {t.odsToDwdCenterUi.bulkClearSelection}
                </button>
                <button
                  type="button"
                  disabled={building || bulkStats.batchN === 0}
                  className="rounded-[6px] border border-border bg-white px-3 py-1 text-[12px] text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
                  onClick={() => void runBulkIncremental()}
                >
                  {bulkProgressLabel != null
                    ? `${t.odsToDwdCenterUi.bulkIncrementalBuild}（${bulkProgressLabel}）`
                    : `${t.odsToDwdCenterUi.bulkIncrementalBuild}（${t.odsToDwdCenterUi.bulkIncrementalSummary.replace('{b}', String(bulkStats.batchN)).replace('{s}', String(bulkStats.sessN))}）`}
                </button>
                <span className="text-il-meta text-text-3">{t.odsToDwdCenterUi.bulkToolbarHint}</span>
                <label className="mt-1 flex w-full max-w-[56rem] cursor-pointer items-start gap-2 rounded-[6px] border border-border-light/80 bg-white/80 px-2 py-2 text-[12px] text-text-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={rebuildEnterpriseYearRelAfterDwd}
                    disabled={building}
                    onChange={(e) => setRebuildEnterpriseYearRelAfterDwd(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium text-text">{t.odsToDwdCenterUi.rebuildEnterpriseYearRelLabel}</span>
                    <span className="mt-0.5 block text-il-meta leading-relaxed text-text-3">
                      {t.odsToDwdCenterUi.rebuildEnterpriseYearRelHint}
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {filtered.length === 0 ? (
                <div className="px-4 py-10 text-center text-il-page-desc leading-relaxed text-text-3">
                  {t.odsToDwdCenterUi.filterNoMatchBatches}
                </div>
              ) : (
                <table className="w-max min-w-full border-collapse text-left text-[12px]">
                  <thead className="sticky top-0 z-[1] bg-[#f5f8fc] text-text-2 shadow-sm">
                    <tr>
                      <th className="whitespace-nowrap border-b border-border-light px-2 py-2 font-medium first:pl-4">
                        {t.odsToDwdCenterUi.colBulkExpand}
                      </th>
                      <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium">
                        {t.odsToDwdCenterUi.colBatch}
                      </th>
                      <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium">
                        {t.odsToDwdCenterUi.colOds}
                      </th>
                      <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium">
                        {t.odsToDwdCenterUi.colDwd}
                      </th>
                      <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium">
                        {t.odsToDwdCenterUi.colQuality}
                      </th>
                      <th className="whitespace-nowrap border-b border-border-light px-2.5 py-2 font-medium last:pr-4">
                        {t.odsToDwdCenterUi.colUpdated}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="text-text-2">
                    {filtered.map((r) => {
                    const active = r.batchId === selectedBatchId
                    const b = statusBadge(r.dwdStatus)
                    const quality = r.dwdStatus === 'succeeded' ? '通过' : r.dwdStatus === 'failed' ? '未通过' : '—'
                    const all = sessionIdsInBatch(r)
                    const cur = bulkPick[r.batchId] ?? []
                    const allOn = all.length > 0 && all.every((id) => cur.includes(id))
                    const someOn = cur.length > 0 && !allOn
                    const expanded = expandedBatchId === r.batchId
                    return (
                      <Fragment key={r.batchId}>
                        <tr
                          className={[
                            'border-b border-border-light/80 cursor-pointer hover:bg-[#fafbfc]',
                            active ? 'bg-[#EBF4FF]' : '',
                          ].join(' ')}
                          onClick={() => setSelectedBatchId(r.batchId)}
                          title={r.batchId}
                        >
                          <td
                            className="whitespace-nowrap px-2 py-2 first:pl-4"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                title={expanded ? t.odsToDwdCenterUi.bulkCollapseSessions : t.odsToDwdCenterUi.bulkExpandSessions}
                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border-light bg-white text-[11px] text-text-2 hover:border-accent"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setExpandedBatchId((x) => (x === r.batchId ? null : r.batchId))
                                }}
                              >
                                {expanded ? '▾' : '▸'}
                              </button>
                              <input
                                type="checkbox"
                                checked={allOn}
                                ref={(el) => {
                                  if (el) el.indeterminate = someOn
                                }}
                                disabled={building || all.length === 0}
                                onChange={() => {
                                  if (allOn) {
                                    setBulkPick((prev) => {
                                      const n = { ...prev }
                                      delete n[r.batchId]
                                      return n
                                    })
                                  } else {
                                    setBulkPick((prev) => ({ ...prev, [r.batchId]: [...all] }))
                                  }
                                }}
                              />
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-2 font-mono text-[11px] text-text">
                            {r.batchId}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-2 text-text-2">
                            {r.odsParquetPathCount} 路径 · {r.successCount}/{r.odsFileCount}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-2 text-text-2">
                            <span className={['inline-flex items-center rounded border px-2 py-[1px] text-[11px]', b.cls].join(' ')}>
                              {b.text}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-2 text-text-2">{quality}</td>
                          <td className="whitespace-nowrap px-2.5 py-2 text-text-3 last:pr-4">
                            {formatLoadTime(r.updatedAt)}
                          </td>
                        </tr>
                        {expanded ? (
                          <tr className="border-b border-border-light/80 bg-[#fafbfc]">
                            <td colSpan={6} className="px-4 py-2 pl-10" onClick={(e) => e.stopPropagation()}>
                              <div className="text-il-meta mb-1.5 text-text-3">
                                {t.odsToDwdCenterUi.bulkExpandedSessionListTitle}
                              </div>
                              <div className="flex max-h-[220px] flex-col gap-1.5 overflow-y-auto">
                                {r.sessions.map((s) => {
                                  const sid = String(s.session_id ?? '')
                                  const checked = cur.includes(sid)
                                  const wm = s.dwd_session_processed_at
                                    ? formatLoadTime(s.dwd_session_processed_at)
                                    : '—'
                                  const hasDwdWatermark = Boolean(
                                    s.dwd_session_processed_at != null &&
                                      String(s.dwd_session_processed_at).trim() !== '',
                                  )
                                  return (
                                    <div
                                      key={odsPreviewBatchKey(s)}
                                      className="flex items-start gap-2 rounded-[6px] border border-border-light/60 bg-white px-2 py-1.5"
                                    >
                                      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
                                        <input
                                          type="checkbox"
                                          className="mt-0.5 shrink-0"
                                          checked={checked}
                                          disabled={building}
                                          onChange={(e) => {
                                            const on = e.target.checked
                                            setBulkPick((prev) => {
                                              const set = new Set(prev[r.batchId] ?? [])
                                              if (on) set.add(sid)
                                              else set.delete(sid)
                                              const arr = [...set]
                                              const n = { ...prev }
                                              if (arr.length === 0) delete n[r.batchId]
                                              else n[r.batchId] = arr
                                              return n
                                            })
                                          }}
                                        />
                                        <span className="min-w-0 flex-1 font-mono text-[11px] leading-snug text-text break-all">
                                          {sid}
                                        </span>
                                        <span className="shrink-0 text-[11px] text-text-3">
                                          {t.odsToDwdCenterUi.sessionWatermarkHint}：{wm}
                                        </span>
                                      </label>
                                      {hasDwdWatermark ? (
                                        <button
                                          type="button"
                                          className="shrink-0 rounded-[6px] border border-amber-700/35 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-950 hover:bg-amber-100 disabled:opacity-50"
                                          title={t.odsToDwdCenterUi.forceRebuildHint}
                                          disabled={building}
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            void runForceRebuildForSession(r.batchId, sid)
                                          }}
                                        >
                                          {t.odsToDwdCenterUi.forceRebuild}
                                        </button>
                                      ) : (
                                        <span
                                          className="shrink-0 w-[4.5rem] text-center text-[11px] text-text-3"
                                          title={t.odsToDwdCenterUi.forceRebuildUnavailableHint}
                                        >
                                          —
                                        </span>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </Card>

          <div className="min-h-0 space-y-4">
            <Card title={t.odsToDwdCenterUi.detailCardTitle} className="shrink-0">
              {!current ? (
                <div className="text-il-page-desc text-text-3">
                  {rows.length > 0 && filtered.length === 0
                    ? t.odsToDwdCenterUi.filterNoMatchBatches
                    : t.odsToDwdCenterUi.emptyBody}
                </div>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <div className="text-il-meta text-text-3">{t.odsToDwdCenterUi.kpiBatchId}</div>
                      <div className="mt-0.5 font-mono text-[12px] font-semibold text-text">{current.batchId}</div>
                    </div>
                    <span className={['inline-flex items-center rounded border px-2.5 py-1 text-[12px] font-medium', badge.cls].join(' ')}>
                      {badge.text}
                    </span>
                  </div>

                  <div className="mb-4 grid grid-cols-2 gap-3">
                    <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5">
                      <div className="text-il-meta text-text-3">{t.odsToDwdCenterUi.kpiOdsFiles}</div>
                      <div className="mt-0.5 text-[13px] font-semibold text-text-2">{current.odsParquetPathCount}</div>
                    </div>
                    <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5">
                      <div className="text-il-meta text-text-3">{t.odsToDwdCenterUi.kpiEstRows}</div>
                      <div className="mt-0.5 text-[13px] font-semibold text-text-2">{current.estRows.toLocaleString('zh-CN')}</div>
                    </div>
                    <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5">
                      <div className="text-il-meta text-text-3">{t.odsToDwdCenterUi.kpiDwdRows}</div>
                      <div className="mt-0.5 text-[13px] font-semibold text-text-2">
                        {current.dwdRows == null ? '—' : current.dwdRows.toLocaleString('zh-CN')}
                      </div>
                    </div>
                    <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5">
                      <div className="text-il-meta text-text-3">{t.odsToDwdCenterUi.kpiDuration}</div>
                      <div className="mt-0.5 text-[13px] font-semibold text-text-2">{current.durationLabel}</div>
                    </div>
                  </div>

                  <label className="mb-3 flex cursor-pointer items-start gap-2 rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2.5 text-[12px] text-text-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={rebuildEnterpriseYearRelAfterDwd}
                      disabled={building}
                      onChange={(e) => setRebuildEnterpriseYearRelAfterDwd(e.target.checked)}
                    />
                    <span>
                      <span className="font-medium text-text">{t.odsToDwdCenterUi.rebuildEnterpriseYearRelLabel}</span>
                      <span className="mt-0.5 block text-il-meta leading-relaxed text-text-3">
                        {t.odsToDwdCenterUi.rebuildEnterpriseYearRelHint}
                      </span>
                    </span>
                  </label>

                  <p className="mb-3 text-[11px] leading-relaxed text-text-3">{t.odsToDwdCenterUi.detailForceRebuildHint}</p>

                  <div className="mb-4 rounded-[10px] border border-border-light bg-white p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-[12px] font-medium text-text-2">{t.odsToDwdCenterUi.actionsTitle}</div>
                      <span className="text-il-meta text-text-3">
                        {building ? '处理中…' : t.odsToDwdCenterUi.actionBuildHint}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={building || !current}
                        className="rounded-[7px] bg-accent px-4 py-1.5 text-il-btn font-medium text-white disabled:opacity-60"
                        title={t.odsToDwdCenterUi.actionBuildTitle}
                        onClick={() => void runFullBuild()}
                      >
                        {building ? '处理中…' : t.odsToDwdCenterUi.actionBuild}
                      </button>
                      <button
                        type="button"
                        disabled
                        className="rounded-[7px] border border-border bg-white px-4 py-1.5 text-il-btn text-text-3 opacity-60"
                        title={t.odsToDwdCenterUi.actionDisabledHint}
                      >
                        {t.odsToDwdCenterUi.actionRetryFailed}
                      </button>
                      <button
                        type="button"
                        disabled
                        className="rounded-[7px] border border-border bg-white px-4 py-1.5 text-il-btn text-text-3 opacity-60"
                        title={t.odsToDwdCenterUi.actionDisabledHint}
                      >
                        {t.odsToDwdCenterUi.actionRollback}
                      </button>
                      <button
                        type="button"
                        disabled
                        className="rounded-[7px] border border-border bg-white px-4 py-1.5 text-il-btn text-text-3 opacity-60"
                        title={t.odsToDwdCenterUi.actionDisabledHint}
                      >
                        {t.odsToDwdCenterUi.actionViewLogs}
                      </button>
                    </div>
                  </div>

                  <div className="mb-4 rounded-[10px] border border-border-light bg-white p-3">
                    <div className="mb-2 text-[12px] font-medium text-text-2">{t.odsToDwdCenterUi.stepperTitle}</div>
                    <div className="grid grid-cols-2 gap-2">
                      {(buildDetail?.steps && buildDetail.steps.length > 0
                        ? buildDetail.steps
                        : (
                            [
                              { id: 'read_ods', label: t.odsToDwdCenterUi.steps.readOds },
                              { id: 'standardize', label: t.odsToDwdCenterUi.steps.standardize },
                              { id: 'dedupe', label: t.odsToDwdCenterUi.steps.dedupe },
                              { id: 'enrich', label: t.odsToDwdCenterUi.steps.enrich },
                              { id: 'write_dwd', label: t.odsToDwdCenterUi.steps.writeDwd },
                              { id: 'validate', label: t.odsToDwdCenterUi.steps.validate },
                            ] as const
                          ).map((s) => ({ ...s, status: 'pending', detail: '' }))
                      ).map((s, idx) => {
                        const st = (s as { status?: string }).status ?? 'pending'
                        const label = (s as { label?: string }).label ?? String((s as { id?: string }).id ?? idx)
                        const detail = (s as { detail?: string }).detail
                        const sub =
                          st === 'ok'
                            ? '完成'
                            : st === 'warning'
                              ? '警告'
                              : st === 'skipped'
                                ? '跳过'
                                : st === 'error'
                                  ? '失败'
                                  : '待执行'
                        return (
                          <div key={(s as { id?: string }).id ?? idx} className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2">
                            <div className="text-il-meta text-text-3">{label}</div>
                            <div className="mt-0.5 text-[12px] font-medium text-text-2">{sub}</div>
                            {detail ? (
                              <div className="mt-0.5 text-[11px] leading-snug text-text-3">{detail}</div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="rounded-[10px] border border-border-light bg-white p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-[12px] font-medium text-text-2">{t.odsToDwdCenterUi.panelsTitle}</div>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          className={[
                            'rounded-[7px] px-3 py-1 text-il-btn',
                            activeTab === 'logs'
                              ? 'bg-accent font-medium text-white'
                              : 'border border-border bg-white text-text-2 hover:border-accent hover:text-accent',
                          ].join(' ')}
                          onClick={() => setActiveTab('logs')}
                        >
                          {t.odsToDwdCenterUi.tabLogs}
                        </button>
                        <button
                          type="button"
                          className={[
                            'rounded-[7px] px-3 py-1 text-il-btn',
                            activeTab === 'metrics'
                              ? 'bg-accent font-medium text-white'
                              : 'border border-border bg-white text-text-2 hover:border-accent hover:text-accent',
                          ].join(' ')}
                          onClick={() => setActiveTab('metrics')}
                        >
                          {t.odsToDwdCenterUi.tabMetrics}
                        </button>
                      </div>
                    </div>
                    {activeTab === 'logs' ? (
                      <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2 text-[12px] leading-relaxed text-text-2">
                        <div className="mb-1 font-mono text-[11px] text-text-3">
                          [{odsPreviewBatchKey(current.sessions[0] ?? { batch_id: current.batchId, session_id: '—' } as any)}]
                        </div>
                        {buildDetail?.logText ? (
                          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-text-2">
                            {buildDetail.logText}
                          </pre>
                        ) : (
                          <>
                            <div className="text-text-2">{t.odsToDwdCenterUi.logsPlaceholder}</div>
                            <p className="mt-2 rounded-[6px] border border-amber-200/80 bg-amber-50/90 px-2.5 py-2 text-[11px] leading-relaxed text-amber-950/90">
                              {t.odsToDwdCenterUi.logsPrototypeNote}
                            </p>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-[8px] border border-border-light bg-[#fafbfc] px-3 py-2 text-[12px] leading-relaxed text-text-2">
                        <div className="text-text-2">{t.odsToDwdCenterUi.metricsPlaceholder}</div>
                        <p className="mt-2 text-[11px] text-text-3">{t.odsToDwdCenterUi.metricsPrototypeNote}</p>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <div className="rounded-[8px] border border-border-light bg-white px-3 py-2">
                            <div className="text-il-meta text-text-3">关键字段空值率</div>
                            <div className="mt-0.5 text-[12px] font-semibold text-text-2">0.23%</div>
                          </div>
                          <div className="rounded-[8px] border border-border-light bg-white px-3 py-2">
                            <div className="text-il-meta text-text-3">主键重复率</div>
                            <div className="mt-0.5 text-[12px] font-semibold text-text-2">0.01%</div>
                          </div>
                          <div className="rounded-[8px] border border-border-light bg-white px-3 py-2">
                            <div className="text-il-meta text-text-3">金额校验（通过）</div>
                            <div className="mt-0.5 text-[12px] font-semibold text-text-2">98.7%</div>
                          </div>
                          <div className="rounded-[8px] border border-border-light bg-white px-3 py-2">
                            <div className="text-il-meta text-text-3">异常规则命中</div>
                            <div className="mt-0.5 text-[12px] font-semibold text-text-2">12</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}

