import { useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { zhCN as t } from '../copy/zh-CN'

type EnterpriseRow = {
  enterpriseName: string
  taxpayerId: string
  topCategory: string
  topCategoryRatio: string
  highRiskRatio: string
  fluctuationIndex: string
}

type MockScenario = 'manufacturing' | 'trade' | 'service'

type ScenarioPack = {
  kpis: {
    enterpriseCoverage: string
    highRiskEnterpriseCount: string
    topCategoryConcentration: string
    monthlyMutationRate: string
  }
  rows: EnterpriseRow[]
}

const SCENARIO_DATA: Record<MockScenario, ScenarioPack> = {
  manufacturing: {
    kpis: {
      enterpriseCoverage: '88.1%',
      highRiskEnterpriseCount: '14',
      topCategoryConcentration: '52.3%',
      monthlyMutationRate: '11.2%',
    },
    rows: [
      {
        enterpriseName: '华东精密机械股份有限公司',
        taxpayerId: '91310100MA1A111111',
        topCategory: '机械设备',
        topCategoryRatio: '46.2%',
        highRiskRatio: '7.8%',
        fluctuationIndex: '1.31',
      },
      {
        enterpriseName: '天诚设备制造有限公司',
        taxpayerId: '91320100MA21XXXXXX',
        topCategory: '金属制品',
        topCategoryRatio: '38.4%',
        highRiskRatio: '9.2%',
        fluctuationIndex: '1.48',
      },
      {
        enterpriseName: '新航科技发展有限公司',
        taxpayerId: '91440300MA5GXXXXXX',
        topCategory: '修理修配劳务',
        topCategoryRatio: '29.1%',
        highRiskRatio: '12.4%',
        fluctuationIndex: '1.67',
      },
    ],
  },
  trade: {
    kpis: {
      enterpriseCoverage: '76.4%',
      highRiskEnterpriseCount: '41',
      topCategoryConcentration: '36.0%',
      monthlyMutationRate: '6.3%',
    },
    rows: [
      {
        enterpriseName: '瑞华供应链管理有限公司',
        taxpayerId: '91310115MA1K222222',
        topCategory: '批发业',
        topCategoryRatio: '44.8%',
        highRiskRatio: '5.2%',
        fluctuationIndex: '1.09',
      },
      {
        enterpriseName: '跨境通商贸（上海）有限公司',
        taxpayerId: '91310000MA1B333333',
        topCategory: '零售业',
        topCategoryRatio: '39.1%',
        highRiskRatio: '8.6%',
        fluctuationIndex: '1.24',
      },
      {
        enterpriseName: '恒达进出口贸易有限公司',
        taxpayerId: '91440101MA5C444444',
        topCategory: '贸易经纪与代理',
        topCategoryRatio: '33.5%',
        highRiskRatio: '11.0%',
        fluctuationIndex: '1.41',
      },
    ],
  },
  service: {
    kpis: {
      enterpriseCoverage: '82.7%',
      highRiskEnterpriseCount: '33',
      topCategoryConcentration: '28.4%',
      monthlyMutationRate: '14.6%',
    },
    rows: [
      {
        enterpriseName: '云启信息技术服务有限公司',
        taxpayerId: '91110108MA5D555555',
        topCategory: '信息技术服务',
        topCategoryRatio: '41.2%',
        highRiskRatio: '10.5%',
        fluctuationIndex: '1.72',
      },
      {
        enterpriseName: '和悦商务咨询有限公司',
        taxpayerId: '91310110MA5E666666',
        topCategory: '现代服务',
        topCategoryRatio: '35.6%',
        highRiskRatio: '14.2%',
        fluctuationIndex: '1.58',
      },
      {
        enterpriseName: '康居物业管理有限公司',
        taxpayerId: '91440300MA5F777777',
        topCategory: '生活服务',
        topCategoryRatio: '27.3%',
        highRiskRatio: '6.9%',
        fluctuationIndex: '1.19',
      },
    ],
  },
}

export function TaxCodeEnterpriseAnalysisPage() {
  const ui = t.taxCodeEnterpriseUi
  const [mockScenario, setMockScenario] = useState<MockScenario>('manufacturing')
  const [statYear, setStatYear] = useState('2026')
  const [enterpriseKeyword, setEnterpriseKeyword] = useState('')
  const [industry, setIndustry] = useState('all')

  const pack = SCENARIO_DATA[mockScenario]

  const industryOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of pack.rows) {
      if (r.topCategory) set.add(r.topCategory)
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [pack.rows])

  const rows = useMemo(() => {
    const kw = enterpriseKeyword.trim().toLowerCase()
    return pack.rows.filter((row) => {
      const hitKw =
        !kw ||
        row.enterpriseName.toLowerCase().includes(kw) ||
        row.taxpayerId.toLowerCase().includes(kw) ||
        row.topCategory.toLowerCase().includes(kw)
      const hitIndustry = industry === 'all' || row.topCategory === industry
      return hitKw && hitIndustry
    })
  }, [pack.rows, enterpriseKeyword, industry])

  const kpiItems = useMemo(
    () => [
      { label: ui.kpiEnterpriseCoverage, value: pack.kpis.enterpriseCoverage, cls: 'text-accent' as const },
      { label: ui.kpiHighRiskEnterpriseCount, value: pack.kpis.highRiskEnterpriseCount, cls: 'text-danger' as const },
      { label: ui.kpiTopCategoryConcentration, value: pack.kpis.topCategoryConcentration, cls: 'text-warn' as const },
      { label: ui.kpiMonthlyMutationRate, value: pack.kpis.monthlyMutationRate, cls: 'text-text' as const },
    ],
    [pack.kpis, ui],
  )

  const scenarioFocus = useMemo(() => {
    if (mockScenario === 'manufacturing') return ui.scenarioFocusManufacturing
    if (mockScenario === 'trade') return ui.scenarioFocusTrade
    return ui.scenarioFocusService
  }, [mockScenario, ui])

  const scenarioBtn = (key: MockScenario, label: string) => {
    const active = mockScenario === key
    return (
      <button
        key={key}
        type="button"
        onClick={() => {
          setMockScenario(key)
          setIndustry('all')
        }}
        className={[
          'rounded-sm border px-3 py-1.5 text-il-page-desc font-semibold transition',
          active ? 'border-accent bg-[#f0f7ff] text-accent' : 'border-border bg-white text-text-2 hover:border-accent hover:text-accent',
        ].join(' ')}
      >
        {label}
      </button>
    )
  }

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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-il-label font-medium text-text-2">{ui.mockScenarioLabel}</span>
        {scenarioBtn('manufacturing', ui.mockScenarioManufacturing)}
        {scenarioBtn('trade', ui.mockScenarioTrade)}
        {scenarioBtn('service', ui.mockScenarioService)}
      </div>
      <p className="mb-5 text-il-meta text-text-3">{ui.mockScenarioHint}</p>

      <Card title={ui.scenarioFocusTitle} compact>
        <p className="text-il-page-desc leading-relaxed text-text-2">{scenarioFocus}</p>
      </Card>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpiItems.map((item) => (
          <div key={item.label} className="rounded-[10px] border border-border-light bg-white px-3 py-3 shadow-sm">
            <div className="text-il-label text-text-3">{item.label}</div>
            <div className={['mt-1 text-[20px] font-bold tabular-nums', item.cls].join(' ')}>{item.value}</div>
          </div>
        ))}
      </div>

      <Card title={ui.scopeCardTitle}>
        <div className="grid gap-3 md:grid-cols-3">
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
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.enterpriseKeywordLabel}</label>
            <input
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={enterpriseKeyword}
              onChange={(e) => setEnterpriseKeyword(e.target.value)}
              placeholder={ui.enterpriseKeywordPlaceholder}
            />
          </div>
          <div>
            <label className="mb-1 block text-il-label font-medium text-text-2">{ui.industryLabel}</label>
            <select
              className="w-full rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
            >
              <option value="all">{ui.industryAll}</option>
              {industryOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-2 text-il-meta text-text-3">{ui.scopeHint}</p>
      </Card>

      <Card title={ui.enterpriseTableTitle}>
        <div className="mb-1 text-il-meta text-text-3">{ui.enterpriseTableHint.replace('{count}', String(rows.length))}</div>
        <div className="mb-2 text-il-meta text-text-3">{ui.topCategoryRuleHint}</div>
        <div className="overflow-x-auto rounded-sm border border-border-light">
          <table className="w-full min-w-[920px] border-collapse text-il-page-desc">
            <thead>
              <tr className="border-b border-border-light bg-[#fafbfd] text-left text-il-label text-text-3">
                <th className="px-3 py-2 font-medium">{ui.colEnterpriseName}</th>
                <th className="px-3 py-2 font-medium">{ui.colTaxpayerId}</th>
                <th className="px-3 py-2 font-medium">{ui.colTopCategory}</th>
                <th className="px-3 py-2 font-medium">{ui.colTopCategoryRatio}</th>
                <th className="px-3 py-2 font-medium">{ui.colHighRiskRatio}</th>
                <th className="px-3 py-2 font-medium">{ui.colFluctuationIndex}</th>
              </tr>
            </thead>
            <tbody className="text-text-2">
              {rows.map((row) => (
                <tr key={`${mockScenario}-${row.taxpayerId}`} className="border-b border-border-light last:border-b-0">
                  <td className="px-3 py-2.5 text-text">{row.enterpriseName}</td>
                  <td className="px-3 py-2.5 font-mono text-[12px] text-text">{row.taxpayerId}</td>
                  <td className="px-3 py-2.5">{row.topCategory}</td>
                  <td className="px-3 py-2.5">{row.topCategoryRatio}</td>
                  <td className="px-3 py-2.5 text-danger">{row.highRiskRatio}</td>
                  <td className="px-3 py-2.5">{row.fluctuationIndex}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
