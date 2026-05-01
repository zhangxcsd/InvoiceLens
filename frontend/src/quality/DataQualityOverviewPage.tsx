import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'
import type { NavKey } from '../types'
import { fetchRedInvoiceQualityOverview } from '../config/localApi'

const q = t.dataQualityPrototype

type DomainTone = 'accent' | 'amber' | 'rose' | 'violet' | 'slate'

function DomainCard(props: {
  tone: DomainTone
  title: string
  body: string
  m1Label: string
  m1Value: string
  m2Label: string
  m2Value: string
  block?: string
  warn?: string
  info?: string
  onOpenDetail?: () => void
}) {
  const border: Record<DomainTone, string> = {
    accent: 'border-l-accent',
    amber: 'border-l-[#d9a227]',
    rose: 'border-l-danger',
    violet: 'border-l-[#6b5cb3]',
    slate: 'border-l-text-3',
  }
  return (
    <div
      className={[
        'rounded-[10px] border border-border-light bg-white p-4 shadow-sm',
        'border-l-[3px]',
        border[props.tone],
      ].join(' ')}
    >
      <div className="text-il-card-title font-semibold text-text">{props.title}</div>
      <p className="mt-1.5 text-il-meta leading-relaxed text-text-2">{props.body}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-sm border border-border-light bg-[#fafbfd] px-2.5 py-2">
          <div className="text-il-label uppercase tracking-wide text-text-3">{props.m1Label}</div>
          <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-text">{props.m1Value}</div>
        </div>
        <div className="rounded-sm border border-border-light bg-[#fafbfd] px-2.5 py-2">
          <div className="text-il-label uppercase tracking-wide text-text-3">{props.m2Label}</div>
          <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-text">{props.m2Value}</div>
        </div>
      </div>
      {(props.block || props.warn || props.info) && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-il-label">
          {props.block ? (
            <span className="rounded border border-danger/25 bg-[#fff5f5] px-1.5 py-0.5 text-danger">{props.block}</span>
          ) : null}
          {props.warn ? (
            <span className="rounded border border-[#e8d4a8] bg-[#fff9e9] px-1.5 py-0.5 text-warn">{props.warn}</span>
          ) : null}
          {props.info ? (
            <span className="rounded border border-border-light bg-[#f5f7ff] px-1.5 py-0.5 text-text-2">{props.info}</span>
          ) : null}
        </div>
      )}
      {props.onOpenDetail ? (
        <button
          type="button"
          className="mt-3 text-il-btn font-medium text-accent hover:underline"
          onClick={props.onOpenDetail}
        >
          {q.goDetail} →
        </button>
      ) : null}
    </div>
  )
}

export function DataQualityOverviewPage(props: { onNav: (k: NavKey) => void }) {
  const [batch, setBatch] = useState('1')
  const [rOpen, setROpen] = useState(false)
  const [rq, setRq] = useState({
    red_invoice_count: 0,
    unmatched_blue_count: 0,
    orphan_red_count: 0,
    matched_blue_count: 0,
  })
  const [rqErr, setRqErr] = useState('')

  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    void fetchRedInvoiceQualityOverview({ signal: ac.signal }).then((res) => {
      if (!alive) return
      if (res.ok) {
        setRq({
          red_invoice_count: res.red_invoice_count,
          unmatched_blue_count: res.unmatched_blue_count,
          orphan_red_count: res.orphan_red_count,
          matched_blue_count: res.matched_blue_count,
        })
        setRqErr('')
      } else {
        setRqErr(res.error?.message ?? '加载失败')
      }
    })
    return () => {
      alive = false
      ac.abort()
    }
  }, [])

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-il-page-title font-semibold text-text">{q.overviewTitle}</h1>
            <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">
              {q.prototypeBadge}
            </span>
          </div>
          <p className="mt-2 max-w-[820px] text-il-page-desc leading-relaxed text-text-2">{q.overviewLead}</p>
          <p className="mt-2 text-il-meta text-text-3">{q.prototypeNote}</p>
        </div>
        <div className="flex flex-shrink-0 flex-col gap-2 sm:items-end">
          <label className="text-il-label font-medium text-text-2">{q.batchLabel}</label>
          <select
            className="min-w-[220px] rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
          >
            <option value="1">{q.batchOpt1}</option>
            <option value="2">{q.batchOpt2}</option>
          </select>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-sm border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
              onClick={() => props.onNav('import_quality_trend')}
            >
              {q.goTrend}
            </button>
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { k: q.kpiScanned, v: '12,480', c: 'text-text' },
          { k: q.kpiAnomaly, v: '186', c: 'text-warn' },
          { k: q.kpiBlock, v: '14', c: 'text-danger' },
          { k: q.kpiWarn, v: '122', c: 'text-warn' },
          { k: q.kpiInfo, v: '50', c: 'text-text-2' },
        ].map((row) => (
          <div
            key={row.k}
            className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm"
          >
            <div className="text-il-label text-text-3">{row.k}</div>
            <div className={['mt-1 text-[20px] font-bold tabular-nums', row.c].join(' ')}>{row.v}</div>
          </div>
        ))}
      </div>

      <div className="mb-1 text-il-label font-semibold uppercase tracking-wide text-text-3">{q.domainSection}</div>
      <div className="mb-5 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        <DomainCard
          tone="slate"
          title={q.domainA_title}
          body={q.domainA_body}
          m1Label={q.domainA_metric1}
          m1Value="6"
          m2Label={q.domainA_metric2}
          m2Value="11"
          block={`2 ${q.severityBlock}`}
          warn={`9 ${q.severityWarn}`}
          onOpenDetail={() => props.onNav('import_quality_detail')}
        />
        <DomainCard
          tone="accent"
          title={q.domainB_title}
          body={q.domainB_body}
          m1Label={q.domainB_metric1}
          m1Value="38"
          m2Label={q.domainB_metric2}
          m2Value="12"
          warn={`38 ${q.severityWarn}`}
          info={`12 ${q.severityInfo}`}
          onOpenDetail={() => props.onNav('import_quality_detail')}
        />
        <DomainCard
          tone="amber"
          title={q.domainC_title}
          body={q.domainC_body}
          m1Label={q.domainC_metric1}
          m1Value="24"
          m2Label={q.domainC_metric2}
          m2Value="¥ 0.03"
          block={`3 ${q.severityBlock}`}
          warn={`21 ${q.severityWarn}`}
          onOpenDetail={() => props.onNav('import_quality_detail')}
        />
        <DomainCard
          tone="violet"
          title={q.domainD_title}
          body={q.domainD_body}
          m1Label={q.domainD_metric1}
          m1Value="7"
          m2Label={q.domainD_metric2}
          m2Value="1,204"
          info={`7 ${q.severityInfo}`}
          onOpenDetail={() => props.onNav('import_quality_detail')}
        />
        <DomainCard
          tone="slate"
          title="红票蓝票关联质量"
          body="跟踪红票关联蓝票成功率，单独识别“孤立红票（备注可解析但蓝票未入库）”。"
          m1Label="未匹配蓝票"
          m1Value={String(rq.unmatched_blue_count)}
          m2Label="孤立红票"
          m2Value={String(rq.orphan_red_count)}
          warn={`${rq.unmatched_blue_count} ${q.severityWarn}`}
          info={`已匹配 ${rq.matched_blue_count}`}
          onOpenDetail={() => props.onNav('import_quality_detail')}
        />
      </div>
      {rqErr ? <p className="mb-4 text-il-meta text-danger">红票关联质量加载失败：{rqErr}</p> : null}

      <Card title={q.dupSectionTitle}>
        <p className="mb-3 text-il-page-desc leading-relaxed text-text-2">{q.dupSectionLead}</p>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[640px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{q.dupColObject}</th>
                <th className="px-3 py-2 font-medium">{q.dupColRule}</th>
                <th className="w-[120px] px-3 py-2 font-medium text-right">{q.dupColCount}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              <tr className="border-b border-border-light">
                <td className="px-3 py-2.5 font-medium text-text">{q.dupHdr}</td>
                <td className="px-3 py-2.5 leading-relaxed">{q.dupHdrRule}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-text">6</td>
              </tr>
              <tr className="border-b border-border-light">
                <td className="px-3 py-2.5 font-medium text-text">{q.dupDtl}</td>
                <td className="px-3 py-2.5 leading-relaxed">{q.dupDtlRule}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-text">19</td>
              </tr>
              <tr>
                <td className="px-3 py-2.5 font-medium text-text">{q.dupSpc}</td>
                <td className="px-3 py-2.5 leading-relaxed">{q.dupSpcRule}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-text">31</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={q.rulesSectionTitle}>
        <button
          type="button"
          className="mb-2 text-il-btn font-medium text-accent hover:underline"
          onClick={() => setROpen((v) => !v)}
        >
          {rOpen ? q.rulesCollapse : q.rulesExpand}
        </button>
        {rOpen ? (
          <ul className="list-inside list-decimal space-y-1.5 text-il-page-desc text-text-2">
            <li>{q.ruleR1}</li>
            <li>{q.ruleR2}</li>
            <li>{q.ruleR3}</li>
            <li>{q.ruleR4}</li>
            <li>{q.ruleR5}</li>
          </ul>
        ) : (
          <p className="text-il-meta text-text-3">DQ 规则 ID 与 `cleaner` 返回的 `dq_*` 键对齐后，可在此展示启用/阈值与说明链接。</p>
        )}
      </Card>

      <Card title={q.sampleSectionTitle}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-2 py-2 font-medium">{q.sampleColTicket}</th>
                <th className="px-2 py-2 font-medium">{q.sampleColDomain}</th>
                <th className="px-2 py-2 font-medium">{q.sampleColRule}</th>
                <th className="px-2 py-2 font-medium">{q.sampleColSev}</th>
                <th className="px-2 py-2 font-medium">{q.sampleColDelta}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              <tr className="border-b border-border-light">
                <td className="whitespace-nowrap px-2 py-2 font-mono text-[11px] text-text">3702…091234**</td>
                <td className="px-2 py-2">{q.domainB_title}</td>
                <td className="px-2 py-2">建筑专项 vs 明细行数</td>
                <td className="px-2 py-2">
                  <span className="rounded border border-[#e8d4a8] bg-[#fff9e9] px-1.5 text-warn">{q.severityWarn}</span>
                </td>
                <td className="px-2 py-2">汇总 5 行 / 专项 4 行</td>
              </tr>
              <tr className="border-b border-border-light">
                <td className="whitespace-nowrap px-2 py-2 font-mono text-[11px] text-text">1310…008812**</td>
                <td className="px-2 py-2">{q.domainC_title}</td>
                <td className="px-2 py-2">价税合计 vs 明细</td>
                <td className="px-2 py-2">
                  <span className="rounded border border-danger/25 bg-[#fff5f5] px-1.5 text-danger">{q.severityBlock}</span>
                </td>
                <td className="px-2 py-2">差额 ¥120.00</td>
              </tr>
              <tr>
                <td className="whitespace-nowrap px-2 py-2 font-mono text-[11px] text-text">4403…556677**</td>
                <td className="px-2 py-2">{q.domainA_title}</td>
                <td className="px-2 py-2">{q.dupHdr}</td>
                <td className="px-2 py-2">
                  <span className="rounded border border-[#e8d4a8] bg-[#fff9e9] px-1.5 text-warn">{q.severityWarn}</span>
                </td>
                <td className="px-2 py-2">同键 2 条头记录</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
