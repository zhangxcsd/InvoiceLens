import { useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN } from '../copy/zh-CN'
import type { NavKey } from '../types'
import {
  fetchRedInvoiceQualityDetails,
  parseRedInvoiceBzDebug,
  type RedInvoiceQualityDetailRow,
} from '../config/localApi'

const q = zhCN.dataQualityPrototype

export function DataQualityDetailPage(props: { onNav: (k: NavKey) => void }) {
  const [domain, setDomain] = useState('red_link')
  const [sev, setSev] = useState('')
  const [rows, setRows] = useState<RedInvoiceQualityDetailRow[]>([])
  const [err, setErr] = useState('')
  const [bzInput, setBzInput] = useState('')
  const [bzDebugLoading, setBzDebugLoading] = useState(false)
  const [bzDebugResult, setBzDebugResult] = useState<{
    ok: boolean
    matched: boolean
    rule_name?: string | null
    mode?: string | null
    matched_text?: string | null
    target_blue_header_uuid?: string | null
    groups?: string[]
    error?: { message?: string; detail?: string }
  } | null>(null)
  const bzDebugSectionRef = useRef<HTMLDivElement | null>(null)

  const runBzDebug = async (text: string) => {
    const v = text.trim()
    if (!v) return
    setBzDebugLoading(true)
    const r = await parseRedInvoiceBzDebug({ bz: v })
    setBzDebugResult(r)
    setBzDebugLoading(false)
  }

  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    void fetchRedInvoiceQualityDetails({ onlyUnmatched: true, limit: 300, signal: ac.signal }).then((res) => {
      if (!alive) return
      if (res.ok) {
        setRows(res.rows)
        setErr('')
      } else {
        setRows([])
        setErr(res.error?.message ?? '加载失败')
      }
    })
    return () => {
      alive = false
      ac.abort()
    }
  }, [])

  const viewRows = useMemo(() => {
    return rows.filter((r) => {
      if (domain && domain !== 'red_link') return false
      if (sev === 'block' && !r.is_orphan_red) return false
      if (sev === 'warn' && r.is_orphan_red) return false
      return true
    })
  }, [rows, domain, sev])

  const sevBadge = (isOrphan: boolean) => {
    if (isOrphan)
      return (
        <span className="rounded border border-danger/25 bg-[#fff5f5] px-1.5 py-0.5 text-il-label text-danger">
          {q.severityBlock}
        </span>
      )
    return (
      <span className="rounded border border-[#e8d4a8] bg-[#fff9e9] px-1.5 py-0.5 text-il-label text-warn">
        {q.severityWarn}
      </span>
    )
  }

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-il-page-title font-semibold text-text">{q.detailTitle}</h1>
            <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">
              {q.prototypeBadge}
            </span>
          </div>
          <p className="mt-2 max-w-[720px] text-il-page-desc leading-relaxed text-text-2">{q.detailLead}</p>
        </div>
        <button
          type="button"
          className="rounded-sm border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
          onClick={() => props.onNav('import_quality_overview')}
        >
          ← {q.linkBackOverview}
        </button>
      </div>

      <Card title={q.filterCardTitle}>
        <div className="flex flex-wrap gap-3">
          <div>
            <label className="mb-1 block text-il-label text-text-3">{q.filterDomain}</label>
            <select
              className="min-w-[200px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            >
              <option value="">{q.filterAll}</option>
              <option value={q.domainA_title}>{q.domainA_title}</option>
              <option value={q.domainB_title}>{q.domainB_title}</option>
              <option value={q.domainC_title}>{q.domainC_title}</option>
              <option value="red_link">红票蓝票关联质量</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-il-label text-text-3">{q.filterSeverity}</label>
            <select
              className="min-w-[140px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
              value={sev}
              onChange={(e) => setSev(e.target.value)}
            >
              <option value="">{q.filterAll}</option>
              <option value="block">{q.severityBlock}</option>
              <option value="warn">{q.severityWarn}</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-il-label text-text-3">{q.filterSpec}</label>
            <select
              className="min-w-[180px] rounded-sm border border-border bg-white px-2 py-1.5 text-il-page-desc outline-none focus:border-accent"
              defaultValue=""
            >
              <option value="">{q.filterAll}</option>
              <option value="p">客运</option>
              <option value="f">货运</option>
              <option value="c">建筑服务</option>
              <option value="v">机动车销售</option>
              <option value="e">不动产租赁</option>
            </select>
          </div>
        </div>
      </Card>

      <div ref={bzDebugSectionRef}>
        <Card title="红票备注规则调试">
          <p className="mb-2 text-il-meta text-text-3">
            输入一段红字发票备注（bz），验证命中规则、提取值与目标蓝票 UUID。
          </p>
          <textarea
            className="min-h-[92px] w-full rounded-sm border border-border bg-white px-2 py-2 text-il-page-desc outline-none focus:border-accent"
            placeholder="例如：对应正数发票代码：123456789012 号码：12345678"
            value={bzInput}
            onChange={(e) => setBzInput(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              className="rounded-sm border border-accent bg-accent px-3 py-1.5 text-il-btn text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={bzDebugLoading || bzInput.trim().length === 0}
              onClick={async () => runBzDebug(bzInput)}
            >
              {bzDebugLoading ? '验证中…' : '立即验证'}
            </button>
          </div>
          {bzDebugResult ? (
            <div className="mt-3 rounded-sm border border-border-light bg-[#fafbfd] p-3 text-il-page-desc text-text-2">
              {bzDebugResult.ok ? (
                <>
                  <div>命中结果：{bzDebugResult.matched ? '已命中' : '未命中'}</div>
                  <div>规则名：{bzDebugResult.rule_name || '—'}</div>
                  <div>模式：{bzDebugResult.mode || '—'}</div>
                  <div className="break-all">命中文本：{bzDebugResult.matched_text || '—'}</div>
                  <div className="break-all">目标蓝票 UUID：{bzDebugResult.target_blue_header_uuid || '—'}</div>
                  <div className="break-all">捕获组：{(bzDebugResult.groups || []).join(' | ') || '—'}</div>
                </>
              ) : (
                <div className="text-danger">调试失败：{bzDebugResult.error?.message || '未知错误'}</div>
              )}
            </div>
          ) : null}
        </Card>
      </div>

      <Card title={q.sampleSectionTitle}>
        <div className="mb-2 flex justify-end gap-2">
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded-sm border border-border-light bg-[#fafbfd] px-3 py-1.5 text-il-btn text-text-3"
          >
            {q.exportCsvDisabled}
          </button>
        </div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[900px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-2 py-2 font-medium">{q.sampleColTicket}</th>
                <th className="px-2 py-2 font-medium">{q.sampleColDomain}</th>
                <th className="px-2 py-2 font-medium">{q.sampleColRule}</th>
                <th className="px-2 py-2 font-medium">{q.sampleColSev}</th>
                <th className="px-2 py-2 font-medium">{q.sampleColDelta}</th>
                <th className="px-2 py-2 font-medium">{q.colDetectedAt}</th>
                <th className="px-2 py-2 font-medium">{q.colActions}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {viewRows.map((r) => (
                <tr key={r.header_uuid} className="border-b border-border-light last:border-0">
                  <td className="whitespace-nowrap px-2 py-2 font-mono text-[11px] text-text">
                    {r.sdfphm || `${r.fpdm}-${r.fphm}`}
                  </td>
                  <td className="px-2 py-2">红票蓝票关联质量</td>
                  <td className="px-2 py-2 font-mono text-[10px] text-text-2">red_blue_link_unmatched</td>
                  <td className="px-2 py-2">{sevBadge(r.is_orphan_red)}</td>
                  <td className="max-w-[240px] px-2 py-2 leading-snug">{r.quality_reason}</td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums text-text-3">{r.import_batch_id}</td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      className="text-il-btn font-medium text-accent hover:underline"
                      onClick={async () => {
                        const text = String(r.bz || '').trim()
                        if (!text) return
                        setBzInput(text)
                        bzDebugSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        await runBzDebug(text)
                      }}
                    >
                      {q.actionDrill}
                    </button>
                  </td>
                </tr>
              ))} 
            </tbody>
          </table>
        </div>
        {err ? <p className="mt-3 text-il-meta text-danger">红票异常明细加载失败：{err}</p> : null}
        {viewRows.length === 0 ? (
          <p className="mt-3 text-il-meta text-text-3">当前筛选下无行（演示数据较少）。</p>
        ) : null}
      </Card>
    </div>
  )
}
