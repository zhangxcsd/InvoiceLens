import { useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'

type UnmatchedRow = {
  ssflbm: string
  lineCount: number
  amountSum: string
  sampleInvoices: string
}

const unmatchedSeed: UnmatchedRow[] = [
  { ssflbm: '9999999999999999999', lineCount: 12, amountSum: '128,430.00', sampleInvoices: '3 张发票' },
  { ssflbm: '（空）', lineCount: 4, amountSum: '0.00', sampleInvoices: '2 张发票' },
]

export function TaxCodeAnalysisPage() {
  const ui = t.taxCodeAnalysisUi
  const [statYear, setStatYear] = useState('2026')
  const [batchKeyword, setBatchKeyword] = useState('')

  const filteredUnmatched = useMemo(() => {
    const kw = batchKeyword.trim().toLowerCase()
    if (!kw) return unmatchedSeed
    return unmatchedSeed.filter((r) => r.ssflbm.toLowerCase().includes(kw))
  }, [batchKeyword])

  return (
    <div className="w-full px-5 py-6">
      <div className="mb-5">
        <div className="flex items-center gap-2">
          <h1 className="text-il-page-title font-semibold text-text">{ui.pageTitle}</h1>
          <span className="rounded border border-[#c8dff7] bg-[#f0f7ff] px-2 py-0.5 text-il-soon font-semibold text-accent">
            {ui.prototypeBadge}
          </span>
        </div>
        <p className="mt-2 max-w-[920px] text-il-page-desc leading-relaxed text-text-2">{ui.pageDesc}</p>
        <p className="mt-2 text-il-meta text-text-3">{ui.prototypeNote}</p>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: ui.kpiMatchRate, value: '98.42%', cls: 'text-accent' },
          { label: ui.kpiUnmatchedLines, value: String(filteredUnmatched.reduce((s, r) => s + r.lineCount, 0)), cls: 'text-warn' },
          { label: ui.kpiHighRiskAmountShare, value: '6.8%', cls: 'text-danger' },
          { label: ui.kpiTopCategoryShare, value: '12.1%', cls: 'text-text' },
        ].map((item) => (
          <div key={item.label} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
            <div className="text-il-label text-text-3">{item.label}</div>
            <div className={['mt-1 text-[20px] font-bold tabular-nums', item.cls].join(' ')}>{item.value}</div>
          </div>
        ))}
      </div>

      <Card title={ui.scopeCardTitle}>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.statYearLabel}</label>
            <select
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={statYear}
              onChange={(e) => setStatYear(e.target.value)}
            >
              <option value="2026">2026</option>
              <option value="2025">2025</option>
              <option value="2024">2024</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.batchKeywordLabel}</label>
            <input
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={batchKeyword}
              onChange={(e) => setBatchKeyword(e.target.value)}
              placeholder={ui.batchKeywordPlaceholder}
            />
          </div>
        </div>
        <p className="mt-2 text-il-meta text-text-3">{ui.scopeHint}</p>
      </Card>

      <Card title={ui.unmatchedTableTitle}>
        <div className="mb-2 text-il-meta text-text-3">{ui.unmatchedTableHint}</div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[720px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{ui.colSsflbm}</th>
                <th className="px-3 py-2 font-medium">{ui.colLineCount}</th>
                <th className="px-3 py-2 font-medium">{ui.colAmountSum}</th>
                <th className="px-3 py-2 font-medium">{ui.colSampleInvoices}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {filteredUnmatched.map((row) => (
                <tr key={row.ssflbm} className="border-b border-border-light last:border-b-0">
                  <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.ssflbm}</td>
                  <td className="px-3 py-2.5">{row.lineCount}</td>
                  <td className="px-3 py-2.5">{row.amountSum}</td>
                  <td className="px-3 py-2.5">{row.sampleInvoices}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={ui.nextCardTitle}>
        <ul className="list-inside list-disc space-y-1 text-il-page-desc text-text-2">
          {ui.nextBullets.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
