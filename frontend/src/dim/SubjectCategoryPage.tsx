import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PrototypePageHeader } from '../components/PrototypePageHeader'
import { zhCN as t } from '../copy/zh-CN'
import {
  fetchSubjectCategoryRules,
  fetchSubjectCategoryRecomputeLatest,
  saveSubjectCategoryRules,
  type SubjectCategoryRecomputeSummary,
  type SubjectCategoryRuleDto,
} from '../config/localApi'

type SubjectCategoryRow = {
  categoryCode: string
  categoryName: string
  gbCode: string
  registerAuthority: string
  legalForm: string
  invoiceScene: string
  defaultRiskFocus: string
  enabled: boolean
  coverageCount: number
}

const seedRows: SubjectCategoryRow[] = [
  {
    categoryCode: 'SC-ENT',
    categoryName: '企业独立法人',
    gbCode: '1',
    registerAuthority: '工商',
    legalForm: '公司、非公司企业法人',
    invoiceScene: '主体识别主干匹配，默认按统一社会信用代码优先',
    defaultRiskFocus:
      '集团内关联购销定价偏离、收入确认与开票时点错配、异常毛利率或税负缺口、资本性支出费用化或虚列成本发票',
    enabled: true,
    coverageCount: 0,
  },
  {
    categoryCode: 'SC-BRANCH',
    categoryName: '企业分支机构',
    gbCode: '2',
    registerAuthority: '工商',
    legalForm: '分公司、营业部、项目部等',
    invoiceScene: '母子主体口径归并与跨地区经营链路匹配',
    defaultRiskFocus:
      '费用上划或内部服务向母体/兄弟机构转移利润、同一项目多主体分摊不合理、跨地区增值税与所得税口径不一致、与母体开票抬头混用',
    enabled: true,
    coverageCount: 0,
  },
  {
    categoryCode: 'SC-SELF',
    categoryName: '个体工商户',
    gbCode: '3',
    registerAuthority: '工商',
    legalForm: '个体工商户营业执照主体',
    invoiceScene: '小微主体交易匹配与自然人经营口径区分',
    defaultRiskFocus:
      '经营者与关联自然人账户混同、定额或核定与实际开票严重偏离、短期内大额开票与进项结构不匹配、走账或挂靠开票',
    enabled: true,
    coverageCount: 0,
  },
  {
    categoryCode: 'SC-COOP',
    categoryName: '农民专业合作社',
    gbCode: '4',
    registerAuthority: '工商',
    legalForm: '农民专业合作社、联合社',
    invoiceScene: '农业生产流通场景匹配与成员交易链路核查',
    defaultRiskFocus:
      '成员及关联方购销异常、农副收购进项真实性（自开、过票）、返利或二次结算未开票、空壳社集中对外开票',
    enabled: true,
    coverageCount: 0,
  },
  {
    categoryCode: 'SC-SOCIAL',
    categoryName: '社会团体',
    gbCode: '5',
    registerAuthority: '民政',
    legalForm: '社会团体、基金会、民办非企业',
    invoiceScene: '项目经费流向与服务采购链路',
    defaultRiskFocus:
      '会费与捐赠资金流向、采购或会议服务缺乏成果印证、基金会投向关联方、免税与应税收入划分及票据支撑不足',
    enabled: true,
    coverageCount: 0,
  },
  {
    categoryCode: 'SC-INSTITUTION',
    categoryName: '机关事业单位',
    gbCode: '6',
    registerAuthority: '机构编制',
    legalForm: '党政机关、学校、医院、研究院等',
    invoiceScene: '预算执行与采购场景发票核查',
    defaultRiskFocus:
      '政府采购串标围标线索、预算科目与采购品类错配、三公及培训会议费异常、供应商与经办人异常关联（利益输送）',
    enabled: true,
    coverageCount: 0,
  },
  {
    categoryCode: 'SC-TEMP',
    categoryName: '临时税务登记主体',
    gbCode: '7',
    registerAuthority: '其他',
    legalForm: '自然人代开、临时经营个体',
    invoiceScene: '零散开票补充主体、自然人交易链路',
    defaultRiskFocus:
      '自然人代开集中大额、身份证或支付账户复用链条、短期登记后高频开票或快速注销、无实质经营的高流水走票',
    enabled: true,
    coverageCount: 0,
  },
]

type FilterType = 'all' | 'enabled' | 'disabled'
type FormState = Pick<
  SubjectCategoryRow,
  | 'categoryCode'
  | 'categoryName'
  | 'gbCode'
  | 'registerAuthority'
  | 'legalForm'
  | 'invoiceScene'
  | 'defaultRiskFocus'
  | 'enabled'
>

const _TOP1_WARN_RAW = (import.meta as any).env?.VITE_SUBJECT_TOP1_WARN_THRESHOLD
const _TOP1_WARN_NUM = Number(_TOP1_WARN_RAW)
const RECOMPUTE_TOP1_HIGH_THRESHOLD =
  Number.isFinite(_TOP1_WARN_NUM) && _TOP1_WARN_NUM > 0 ? Math.floor(_TOP1_WARN_NUM) : 70

function toDto(rows: SubjectCategoryRow[]): SubjectCategoryRuleDto[] {
  return rows.map((x) => ({
    category_code: x.categoryCode,
    category_name: x.categoryName,
    gb_code: x.gbCode,
    register_authority: x.registerAuthority,
    legal_form: x.legalForm,
    invoice_scene: x.invoiceScene,
    default_risk_focus: x.defaultRiskFocus,
    coverage_count: 0,
    enabled: x.enabled,
  }))
}

function fromDto(rows: SubjectCategoryRuleDto[]): SubjectCategoryRow[] {
  return rows.map((x) => ({
    categoryCode: x.category_code,
    categoryName: x.category_name,
    gbCode: x.gb_code,
    registerAuthority: x.register_authority,
    legalForm: x.legal_form,
    invoiceScene: x.invoice_scene,
    defaultRiskFocus: x.default_risk_focus,
    enabled: x.enabled,
    coverageCount: Number.isFinite(x.coverage_count) ? Math.max(0, Math.floor(x.coverage_count)) : 0,
  }))
}

function normalizeDraftRows(rows: unknown[]): SubjectCategoryRow[] {
  return rows
    .filter((x) => x && typeof x === 'object')
    .map((x) => {
      const row = x as Partial<SubjectCategoryRow>
      const coverageRaw = Number((row as any).coverageCount ?? 0)
      return {
        categoryCode: String(row.categoryCode ?? '').trim(),
        categoryName: String(row.categoryName ?? '').trim(),
        gbCode: String(row.gbCode ?? '').trim(),
        registerAuthority: String(row.registerAuthority ?? '其他').trim() || '其他',
        legalForm: String(row.legalForm ?? '').trim(),
        invoiceScene: String(row.invoiceScene ?? '').trim(),
        defaultRiskFocus: String(row.defaultRiskFocus ?? '').trim(),
        enabled: Boolean(row.enabled),
        coverageCount: Number.isFinite(coverageRaw) ? Math.max(0, Math.floor(coverageRaw)) : 0,
      }
    })
    .filter((x) => x.categoryCode.length > 0)
}

export function SubjectCategoryPage(props: { onNavigateToRebuild?: () => void }) {
  const LS_KEY = 'invoicelens.subjectCategoryDraft.v1'
  const ui = t.subjectCategoryUi
  const [rows, setRows] = useState<SubjectCategoryRow[]>(seedRows)
  const [standardVersion, setStandardVersion] = useState<string>(ui.standardVersion)
  const [banner, setBanner] = useState('')
  const [error, setError] = useState('')
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<FilterType>('all')
  const [activeCode, setActiveCode] = useState(seedRows[0]?.categoryCode ?? '')
  const [showDialog, setShowDialog] = useState(false)
  const [editCode, setEditCode] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const [rebuildHint, setRebuildHint] = useState('')
  const [latestRecompute, setLatestRecompute] = useState<SubjectCategoryRecomputeSummary | null>(null)
  const [form, setForm] = useState<FormState>({
    categoryCode: '',
    categoryName: '',
    gbCode: '',
    legalForm: '',
    invoiceScene: '',
    defaultRiskFocus: '',
    registerAuthority: '其他',
    enabled: true,
  })

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { standardVersion?: string; rows?: SubjectCategoryRow[] }
        if (Array.isArray(parsed.rows) && parsed.rows.length > 0) {
          const draftRows = normalizeDraftRows(parsed.rows)
          if (draftRows.length > 0) {
            setRows(draftRows)
            setActiveCode(draftRows[0]?.categoryCode ?? '')
          }
        }
        if (typeof parsed.standardVersion === 'string' && parsed.standardVersion.trim()) {
          setStandardVersion(parsed.standardVersion.trim())
        }
      }
    } catch {
      // ignore local draft parse error
    }
  }, [])

  const mergeRulesWithCoverage = async (): Promise<boolean> => {
    const res = await fetchSubjectCategoryRules()
    if (!res.ok) {
      setBanner(ui.bannerOfflineMode)
      return false
    }
    const loadedRows = fromDto(res.categories)
    if (loadedRows.length > 0) {
      setRows(loadedRows)
      setActiveCode((prev) => {
        const stillExists = loadedRows.some((x) => x.categoryCode === prev)
        return stillExists ? prev : loadedRows[0]?.categoryCode ?? ''
      })
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({
            standardVersion: res.standard_version || standardVersion,
            rows: loadedRows,
          }),
        )
      } catch {
        // ignore cache write error
      }
    }
    if (res.standard_version) setStandardVersion(res.standard_version)
    return true
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (cancelled) return
      await mergeRulesWithCoverage()
    })()
    return () => {
      cancelled = true
    }
  }, [ui.bannerOfflineMode])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await fetchSubjectCategoryRecomputeLatest()
      if (cancelled) return
      if (!res.ok) return
      setLatestRecompute(res.latest)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const filteredRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return rows.filter((row) => {
      if (status === 'enabled' && !row.enabled) return false
      if (status === 'disabled' && row.enabled) return false
      if (!kw) return true
      return (
        row.categoryCode.toLowerCase().includes(kw) ||
        row.categoryName.toLowerCase().includes(kw) ||
        row.registerAuthority.toLowerCase().includes(kw) ||
        row.legalForm.toLowerCase().includes(kw) ||
        row.invoiceScene.toLowerCase().includes(kw) ||
        row.defaultRiskFocus.toLowerCase().includes(kw)
      )
    })
  }, [rows, keyword, status])

  const active = useMemo(
    () => filteredRows.find((row) => row.categoryCode === activeCode) ?? filteredRows[0] ?? null,
    [activeCode, filteredRows],
  )

  const enabledCount = rows.filter((x) => x.enabled).length
  const totalCoverage = rows.reduce((sum, x) => sum + x.coverageCount, 0)
  const canReset = keyword.trim().length > 0 || status !== 'all'

  const openCreate = () => {
    setEditCode(null)
    setFormError('')
    setForm({
      categoryCode: '',
      categoryName: '',
      gbCode: '',
      registerAuthority: '其他',
      legalForm: '',
      invoiceScene: '',
      defaultRiskFocus: '',
      enabled: true,
    })
    setShowDialog(true)
  }

  const openEdit = (row: SubjectCategoryRow) => {
    setEditCode(row.categoryCode)
    setFormError('')
    setForm({
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
      gbCode: row.gbCode,
      registerAuthority: row.registerAuthority,
      legalForm: row.legalForm,
      invoiceScene: row.invoiceScene,
      defaultRiskFocus: row.defaultRiskFocus,
      enabled: row.enabled,
    })
    setShowDialog(true)
  }

  const persistRowsToYaml = async (nextRows: SubjectCategoryRow[]) => {
    setBanner('')
    setError('')
    const res = await saveSubjectCategoryRules({
      standard_version: standardVersion.trim() || ui.standardVersion,
      categories: toDto(nextRows),
    })
    if (!res.ok) {
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({
            standardVersion,
            rows: nextRows,
          }),
        )
      } catch {
        // ignore local draft write error
      }
      setError(res.error?.message ?? ui.bannerSaveFailed)
      setBanner(ui.bannerSavedDraftAfterFail)
      return false
    }
    const syncLocalCache = (cacheRows: SubjectCategoryRow[], cacheVersion: string) => {
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({
            standardVersion: cacheVersion,
            rows: cacheRows,
          }),
        )
      } catch {
        // ignore cache write error
      }
    }
    // 保存成功后立即回读后端，确保界面展示与 YAML 实际落盘一致
    const latest = await fetchSubjectCategoryRules()
    if (latest.ok) {
      const loadedRows = fromDto(latest.categories)
      if (loadedRows.length > 0) {
        setRows(loadedRows)
        syncLocalCache(loadedRows, latest.standard_version || standardVersion)
        const stillExists = loadedRows.some((x) => x.categoryCode === activeCode)
        setActiveCode(stillExists ? activeCode : loadedRows[0]?.categoryCode ?? '')
      } else {
        setRows(nextRows)
        syncLocalCache(nextRows, latest.standard_version || standardVersion)
      }
      if (latest.standard_version) setStandardVersion(latest.standard_version)
    } else {
      // 回读失败时至少保持用户刚保存的结果，避免“保存后看起来没变化”
      setRows(nextRows)
      syncLocalCache(nextRows, standardVersion)
    }
    setError('')
    setBanner(res.message ?? ui.bannerSavedYaml)
    return true
  }

  const saveForm = async () => {
    const code = form.categoryCode.trim().toUpperCase()
    const name = form.categoryName.trim()
    if (!code || !name) {
      setFormError(ui.formNeedCodeName)
      return
    }
    const duplicated = rows.some((x) => x.categoryCode === code && x.categoryCode !== editCode)
    if (duplicated) {
      setFormError(ui.formCodeDuplicated)
      return
    }
    const next: SubjectCategoryRow = {
      categoryCode: code,
      categoryName: name,
      gbCode: form.gbCode.trim(),
      registerAuthority: form.registerAuthority.trim(),
      legalForm: form.legalForm.trim(),
      invoiceScene: form.invoiceScene.trim(),
      defaultRiskFocus: form.defaultRiskFocus.trim(),
      enabled: form.enabled,
      coverageCount: rows.find((x) => x.categoryCode === code)?.coverageCount ?? 0,
    }
    const nextRows = editCode ? rows.map((x) => (x.categoryCode === editCode ? next : x)) : [next, ...rows]
    setRows(nextRows)
    setShowDialog(false)
    await persistRowsToYaml(nextRows)
  }

  return (
    <div className="w-full px-5 py-6">
      <PrototypePageHeader
        title={ui.pageTitle}
        note={ui.pageDesc}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openCreate}
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
            >
              {ui.addCategoryBtn}
            </button>
          </div>
        }
      />

      {banner ? (
        <div className="mb-3 rounded-[7px] border border-[#c8e6d0] bg-[#f4fbf6] px-3 py-2 text-il-meta text-[#1b6b3a]">{banner}</div>
      ) : null}
      {error ? (
        <div className="mb-3 rounded-[7px] border border-danger/30 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">{error}</div>
      ) : null}

      <div className="mb-4 grid grid-cols-1 gap-3 xl:grid-cols-4">
        <Card compact>
          <div className="text-il-label text-text-3">{ui.kpiPresetCount}</div>
          <div className="mt-1 text-il-page-title font-semibold text-text">{rows.length}</div>
        </Card>
        <Card compact>
          <div className="text-il-label text-text-3">{ui.kpiEnabledCount}</div>
          <div className="mt-1 text-il-page-title font-semibold text-text">{enabledCount}</div>
        </Card>
        <Card compact>
          <div className="text-il-label text-text-3">{ui.kpiCoverageCount}</div>
          <div className="mt-1 text-il-page-title font-semibold text-text">{totalCoverage.toLocaleString('zh-CN')}</div>
        </Card>
        <Card compact>
          <div className="text-il-label text-text-3">{ui.kpiVersion}</div>
          <div className="mt-1 font-mono text-il-page-title font-semibold text-text">{standardVersion}</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.5fr_0.85fr]">
        <Card title={ui.tableTitle}>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <label className="min-w-[260px] flex-1">
              <span className="mb-1 block text-il-label font-medium text-text-2">{ui.filterKeyword}</span>
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={ui.filterKeywordPlaceholder}
                className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-1.5 text-il-input text-text outline-none focus:border-accent"
              />
            </label>
            <label className="w-[180px]">
              <span className="mb-1 block text-il-label font-medium text-text-2">{ui.filterStatus}</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as FilterType)}
                className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-1.5 text-il-input text-text outline-none focus:border-accent"
              >
                <option value="all">{ui.filterStatusAll}</option>
                <option value="enabled">{ui.filterStatusEnabled}</option>
                <option value="disabled">{ui.filterStatusDisabled}</option>
              </select>
            </label>
            <button
              type="button"
              disabled={!canReset}
              onClick={() => {
                setKeyword('')
                setStatus('all')
              }}
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {ui.filterReset}
            </button>
          </div>

          <div className="overflow-x-auto rounded-[8px] border border-border-light">
            <table className="min-w-full text-left text-il-page-desc">
              <thead className="bg-[#fafbfd] text-il-meta text-text-3">
                <tr>
                  <th className="w-[130px] px-3 py-2">{ui.colCategoryCode}</th>
                  <th className="w-[140px] px-3 py-2">{ui.colCategoryName}</th>
                  <th className="w-[100px] px-3 py-2">{ui.colGbCode}</th>
                  <th className="w-[120px] px-3 py-2">{ui.colRegisterAuthority}</th>
                  <th className="w-[220px] px-3 py-2">{ui.colLegalForm}</th>
                  <th className="w-[100px] px-3 py-2 text-right">{ui.colCoverage}</th>
                  <th className="w-[90px] px-3 py-2">{ui.colAction}</th>
                  <th className="w-[90px] px-3 py-2">{ui.colStatus}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const activeRow = active?.categoryCode === row.categoryCode
                  return (
                    <tr
                      key={row.categoryCode}
                      onClick={() => setActiveCode(row.categoryCode)}
                      className={[
                        'cursor-pointer border-t border-border-light align-top',
                        activeRow ? 'bg-[#f0f7ff]' : 'hover:bg-[#fafcff]',
                      ].join(' ')}
                    >
                      <td className="px-3 py-2 font-mono text-il-meta text-text">{row.categoryCode}</td>
                      <td className="px-3 py-2 font-medium text-text">{row.categoryName}</td>
                      <td className="px-3 py-2 font-mono text-il-meta text-text-2">{row.gbCode}</td>
                      <td className="px-3 py-2 text-text-2">{row.registerAuthority || '—'}</td>
                      <td className="px-3 py-2 text-text-2">{row.legalForm}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-text-2">{row.coverageCount.toLocaleString('zh-CN')}</td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="rounded-[6px] border border-border bg-white px-2 py-[3px] text-il-btn text-text-2 hover:border-accent hover:text-accent"
                          onClick={(e) => {
                            e.stopPropagation()
                            openEdit(row)
                          }}
                        >
                          {ui.editBtn}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={[
                            'inline-flex rounded-full border px-2 py-[1px] text-il-pill font-semibold',
                            row.enabled
                              ? 'border-[#c8e6d0] bg-[#f3fbf5] text-green'
                              : 'border-[#e3e7ef] bg-[#f6f8fc] text-text-3',
                          ].join(' ')}
                        >
                          {row.enabled ? ui.statusEnabled : ui.statusDisabled}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title={ui.detailTitle}>
          {!active ? (
            <div className="text-il-page-desc text-text-3">{ui.emptyHint}</div>
          ) : (
            <div className="space-y-3 text-il-page-desc">
              <div className="rounded-[8px] border border-border-light bg-[#fafbfd] p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="font-semibold text-text">{active.categoryName}</div>
                  <span className="font-mono text-il-meta text-text-3">{active.categoryCode}</span>
                </div>
                <div className="text-il-meta text-text-3">
                  {ui.detailGbCode}: <span className="font-mono text-text-2">{active.gbCode}</span>
                </div>
              </div>

              <div className="grid grid-cols-[120px_1fr] gap-y-2 text-il-meta">
                <div className="text-text-3">{ui.detailCoverage}</div>
                <div className="tabular-nums text-text-2">{active.coverageCount.toLocaleString('zh-CN')}</div>
                <div className="text-text-3">{ui.detailInvoiceScene}</div>
                <div className="whitespace-pre-wrap break-words text-text-2">
                  {active.invoiceScene || '—'}
                </div>
                <div className="col-span-2 my-1 border-t border-border-light" />
                <div className="text-text-3">{ui.detailRiskFocus}</div>
                <div className="whitespace-pre-wrap break-words text-text-2">
                  {active.defaultRiskFocus || '—'}
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title={ui.rebuildTitle} className="mt-4">
        <p className="text-il-page-desc leading-relaxed text-text-2">{ui.rebuildDesc}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:bg-accent-mid"
            onClick={() => {
              if (props.onNavigateToRebuild) {
                props.onNavigateToRebuild()
                return
              }
              setRebuildHint(ui.rebuildFallbackHint)
            }}
          >
            {ui.rebuildCta}
          </button>
          <span className="text-il-meta text-text-3">{ui.recomputeMovedHint}</span>
          <span className="text-il-meta text-text-3">{ui.rebuildHint}</span>
        </div>
        {rebuildHint ? (
          <div className="mt-3 rounded-[7px] border border-[#fde68a] bg-[#fffbeb] px-3 py-2 text-il-meta text-[#92400e]">
            {rebuildHint}
          </div>
        ) : null}
        <div className="mt-3 rounded-[8px] border border-border-light bg-[#fafbfd] p-3">
          <div className="mb-1 text-il-label font-medium text-text-2">{ui.recomputeLatestTitle}</div>
          {!latestRecompute ? (
            <div className="text-il-meta text-text-3">{ui.recomputeLatestEmpty}</div>
          ) : (
            <div className="space-y-1 text-il-meta text-text-2">
              {(() => {
                const sortedDist = [...latestRecompute.category_summary.by_org_category].sort(
                  (a, b) => b.count - a.count || a.org_category.localeCompare(b.org_category),
                )
                const top3Ratio = (
                  (sortedDist.slice(0, 3).reduce((sum, it) => sum + (Number(it.count) || 0), 0) /
                    Math.max(1, latestRecompute.category_summary.total)) *
                  100
                ).toFixed(1)
                const top1Ratio = (
                  ((Number(sortedDist[0]?.count || 0) / Math.max(1, latestRecompute.category_summary.total)) * 100)
                ).toFixed(1)
                const top1HighThreshold = RECOMPUTE_TOP1_HIGH_THRESHOLD
                return (
                  <>
              <div>
                {ui.recomputeLatestRunId}：<span className="font-mono">{latestRecompute.run_id}</span>
              </div>
              <div>
                {ui.recomputeLatestSnapshotId}：<span className="font-mono">{latestRecompute.snapshot_id}</span>
              </div>
              <div>
                {ui.recomputeLatestCreatedAt}：{latestRecompute.created_at || '—'}
              </div>
              <div>
                {ui.recomputeLatestCategory
                  .replace('{total}', String(latestRecompute.category_summary.total))
                  .replace('{matched}', String(latestRecompute.category_summary.matched))
                  .replace('{needsReview}', String(latestRecompute.category_summary.needs_review))
                  .replace('{disabledBlocked}', String(latestRecompute.category_summary.disabled_blocked))}
              </div>
              <div>
                {ui.recomputeLatestRelation
                  .replace('{relationTotal}', String(latestRecompute.relation_summary.relation_total))
                  .replace('{invoiceCount}', String(latestRecompute.relation_summary.trade_invoice_count_sum))
                  .replace('{amount}', Number(latestRecompute.relation_summary.trade_amount_jshj_sum || 0).toLocaleString('zh-CN'))}
              </div>
              <div>{ui.recomputeLatestTop3Ratio.replace('{ratio}', `${top3Ratio}%`)}</div>
              {Number(top1Ratio) > top1HighThreshold ? (
                <div className="rounded-[6px] border border-[#fed7aa] bg-[#fff7ed] px-2.5 py-1.5 text-[#9a3412]">
                  {ui.recomputeLatestTop1HighConcentration.replace('{threshold}', String(top1HighThreshold))}
                </div>
              ) : null}
              <div className="pt-1">
                <div className="mb-1 text-il-label font-medium text-text-2">{ui.recomputeLatestDistTitle}</div>
                <div className="overflow-x-auto rounded-[6px] border border-border-light bg-white">
                  <table className="min-w-full text-left text-il-meta">
                    <thead className="bg-[#f8fafc] text-text-3">
                      <tr>
                        <th className="px-2.5 py-1.5">{ui.recomputeLatestDistColCategory}</th>
                        <th className="px-2.5 py-1.5">{ui.recomputeLatestDistColCategoryName}</th>
                        <th className="px-2.5 py-1.5 text-right">{ui.recomputeLatestDistColCount}</th>
                        <th className="px-2.5 py-1.5 text-right">{ui.recomputeLatestDistColRatio}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedDist.map((it, idx) => {
                        const denom = Math.max(1, latestRecompute.category_summary.total)
                        const ratio = ((it.count / denom) * 100).toFixed(1)
                        return (
                          <tr
                            key={it.org_category}
                            className={[
                              'border-t border-border-light',
                              idx === 0 ? 'bg-[#f0f7ff]' : '',
                            ].join(' ')}
                          >
                            <td className="px-2.5 py-1.5 font-mono text-text-2">
                              <span>{it.org_category || 'UNCLASSIFIED'}</span>
                              {idx === 0 ? (
                                <span className="ml-1.5 inline-flex rounded-full border border-[#bfdbfe] bg-[#dbeafe] px-1.5 py-[1px] text-[10px] font-semibold text-[#1d4ed8]">
                                  {ui.recomputeLatestTop1Badge}
                                </span>
                              ) : null}
                            </td>
                            <td className="max-w-[200px] px-2.5 py-1.5 text-text-2">
                              {it.org_category_display_name || '—'}
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">{it.count.toLocaleString('zh-CN')}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">{ratio}%</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
                  </>
                )
              })()}
            </div>
          )}
        </div>
      </Card>

      {showDialog ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4">
          <div className="w-full max-w-[760px] rounded-[10px] border border-border-light bg-white p-5 shadow-[0_12px_30px_rgba(15,23,42,.18)]">
            <div className="mb-3 text-il-page-title font-semibold text-text">
              {editCode ? ui.editDialogTitle : ui.addDialogTitle}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label>
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.formCode}</span>
                <input
                  value={form.categoryCode}
                  disabled={!!editCode}
                  onChange={(e) => setForm((v) => ({ ...v, categoryCode: e.target.value }))}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent disabled:opacity-60"
                />
              </label>
              <label>
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.formName}</span>
                <input
                  value={form.categoryName}
                  onChange={(e) => setForm((v) => ({ ...v, categoryName: e.target.value }))}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent"
                />
              </label>
              <label>
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.formGbCode}</span>
                <input
                  value={form.gbCode}
                  onChange={(e) => setForm((v) => ({ ...v, gbCode: e.target.value }))}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent"
                />
              </label>
              <label>
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.formRegisterAuthority}</span>
                <select
                  value={form.registerAuthority}
                  onChange={(e) => setForm((v) => ({ ...v, registerAuthority: e.target.value }))}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent"
                >
                  <option value="机构编制">机构编制</option>
                  <option value="民政">民政</option>
                  <option value="工商">工商</option>
                  <option value="其他">其他</option>
                </select>
              </label>
              <label>
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.formLegalForm}</span>
                <input
                  value={form.legalForm}
                  onChange={(e) => setForm((v) => ({ ...v, legalForm: e.target.value }))}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent"
                />
              </label>
              <label className="md:col-span-2">
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.formScene}</span>
                <input
                  value={form.invoiceScene}
                  onChange={(e) => setForm((v) => ({ ...v, invoiceScene: e.target.value }))}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent"
                />
              </label>
              <label className="md:col-span-2">
                <span className="mb-1 block text-il-label font-medium text-text-2">{ui.formRiskFocus}</span>
                <textarea
                  value={form.defaultRiskFocus}
                  onChange={(e) => setForm((v) => ({ ...v, defaultRiskFocus: e.target.value }))}
                  rows={3}
                  className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2.5 py-2 text-il-input text-text outline-none focus:border-accent"
                />
              </label>
            </div>
            <label className="mt-3 inline-flex items-center gap-2 text-il-meta text-text-2">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((v) => ({ ...v, enabled: e.target.checked }))}
              />
              {ui.formEnabled}
            </label>
            {formError ? (
              <div className="mt-3 rounded-[6px] border border-danger/30 bg-[#fff5f5] px-2.5 py-2 text-il-meta text-danger">{formError}</div>
            ) : null}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                onClick={() => setShowDialog(false)}
              >
                {ui.dialogCancel}
              </button>
              <button
                type="button"
                className="rounded-[7px] bg-accent px-3 py-1.5 text-il-btn font-semibold text-white hover:bg-accent-mid"
                onClick={saveForm}
              >
                {ui.dialogConfirm}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
