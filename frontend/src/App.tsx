import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from './components/Card'
import { UploadZone, type PickedExcel } from './components/UploadZone'
import { zhCN as t } from './copy/zh-CN'
import type { NavKey, User } from './types'
import { sheetMappingOptionsFallback } from './config/sheetMappingOptions'
import {
  createImportSessionUpload,
  fetchFieldMapping,
  fetchFieldMappingTemplates,
  fetchImportLimits,
  fetchImportSessionEvents,
  fetchSheetMappingOptions,
  fetchAuditPendingCount,
  fetchAuditRelatedNavCount,
  fetchLicenseInfo,
  LICENSE_UPDATED_EVENT,
  fetchAuthMe,
  getSessionToken,
  postAuthLogin,
  postAuthLogout,
  setAuthExpiredHandler,
  setSessionToken,
  type ApiImportEvent,
} from './config/localApi'
import { runSimulatedImport } from './import/simulator'
import { FALLBACK_FIELD_MAPPING_CONFIG, type FieldMappingConfig } from './import/formatPrecheckInvoice'
import { validateImportQueueFormat } from './import/validateImportQueueFormat'
import { FormatCheckIssueBlocks } from './import/FormatCheckIssueBlocks'
import { filterOutOfficeLockFiles, queueRowKey } from './import/importQueueUtils'
import type { ImportWizardHandoff } from './import/wizardHandoff'
import { SheetCoveragePanel } from './import/SheetCoveragePanel'
import { DataPreviewPage } from './import/DataPreviewPage'
import { OdsOverviewPage } from './import/OdsOverviewPage'
import { ImportHistoryPage } from './import/ImportHistoryPage'
import { DwdPreviewPage } from './dwd/DwdPreviewPage'
import { OdsToDwdCenterPage } from './dwd/OdsToDwdCenterPage'
import { DwdToDimCenterPage } from './dwd/DwdToDimCenterPage'
import { ProcessingDerivedDimTasksPage } from './dwd/ProcessingDerivedDimTasksPage'
import { navToDwdDimWithTask, SUBJECT_DIM_TASK } from './dwd/dwdDimNav'
import { FieldMappingConfigPrototype } from './fieldMapping/FieldMappingConfigPrototype'
import { MappingTemplatesPrototype } from './fieldMapping/MappingTemplatesPrototype'
import { DataQualityOverviewPage } from './quality/DataQualityOverviewPage'
import { DataQualityDetailPage } from './quality/DataQualityDetailPage'
import { DataQualityTrendPage } from './quality/DataQualityTrendPage'
import { HealthScorePage } from './quality/HealthScorePage'
import { EntityProfilePage } from './dws/EntityProfilePage'
import { GoodsCategoryPage } from './dws/GoodsCategoryPage'
import { RedOffsetAnalysisPage } from './dws/RedOffsetAnalysisPage'
import { InvoiceTimingPage } from './dws/InvoiceTimingPage'
import { CounterpartyRiskPage } from './dws/CounterpartyRiskPage'
import { YearOverYearComparePage } from './dws/YearOverYearComparePage'
import { EnterpriseLibraryPage } from './dim/EnterpriseLibraryPage'
import { OverviewSummaryPage } from './dws/OverviewSummaryPage'
import { OverviewTrendPage } from './dws/OverviewTrendPage'
import { OverviewTaxPage } from './dws/OverviewTaxPage'
import { SupplierCrPage } from './dws/SupplierCrPage'
import { SupplierNewPage } from './dws/SupplierNewPage'
import { SupplierTopPage } from './dws/SupplierTopPage'
import { TradeRelationshipsPage } from './dws/TradeRelationshipsPage'
import { TaxInOutDeviationPage } from './dws/TaxInOutDeviationPage'
import { TaxRiskExposurePage } from './dws/TaxRiskExposurePage'
import { FlagsListPage } from './dm/FlagsListPage'
import { FlagsTrackPage } from './dm/FlagsTrackPage'
import { FlagsRulesPage } from './dm/FlagsRulesPage'
import { RelatedPairsPage } from './dm/RelatedPairsPage'
import { RelatedShellPage } from './dm/RelatedShellPage'
import { RelatedGraphPage } from './dm/RelatedGraphPage'
import { CompareRankPage } from './ads/CompareRankPage'
import { CompareChartsPage } from './ads/CompareChartsPage'
import { ReportConfigPage } from './report/ReportConfigPage'
import { ReportArchivePage } from './report/ReportArchivePage'
import { ReportTemplatesPage } from './report/ReportTemplatesPage'
import { InvoiceExportPage } from './import/InvoiceExportPage'
import { FinanceReconcilePage } from './finance/FinanceReconcilePage'
import { FinanceDiffPage } from './finance/FinanceDiffPage'
import { SettingsThresholdsPage } from './settings/SettingsThresholdsPage'
import { SettingsLicensePage } from './settings/SettingsLicensePage'
import { SettingsInstancePage } from './settings/SettingsInstancePage'
import { UsersListPage } from './users/UsersListPage'
import { UsersRolesPage } from './users/UsersRolesPage'
import { UsersAuditPage } from './users/UsersAuditPage'
import { AuditRelatedEnterprisePage } from './dim/AuditRelatedEnterprisePage'
import { EnterpriseYearRosterPage } from './dim/EnterpriseYearRosterPage'
import { Level1EnterpriseYearPage } from './dim/Level1EnterpriseYearPage'
import { AuditedEnterpriseLedgerPage } from './dim/AuditedEnterpriseLedgerPage'
import { AuditedEnterpriseContributionPage } from './dim/AuditedEnterpriseContributionPage'
import { AuditedEnterpriseInvoiceLinkPage } from './dim/AuditedEnterpriseInvoiceLinkPage'
import { InvoiceToAuditedEnterprisePage } from './dim/InvoiceToAuditedEnterprisePage'
import { AuditedEnterpriseTreePage } from './dim/AuditedEnterpriseTreePage'
import { DimOrgSysPage } from './dim/DimOrgSysPage'
import { TaxCodeAnalysisPage } from './dim/TaxCodeAnalysisPage'
import { TaxCodeEnterpriseAnalysisPage } from './dim/TaxCodeEnterpriseAnalysisPage'
import { TaxCodeLibraryPage } from './dim/TaxCodeLibraryPage'
import { TaxCodeRiskDefinePage } from './dim/TaxCodeRiskDefinePage'
import { DimVersionPage } from './dim/DimVersionPage'
import { DimDictPage } from './dim/DimDictPage'
import { SubjectCategoryPage } from './dim/SubjectCategoryPage'
import type { ImportEvent, ImportFailureRecord } from './import/eventTypes'
import { MAX_IMPORT_FILE_MB } from './config/importLimits'
import {
  collectRejectRowsForExport,
  downloadJson,
  downloadRejectRowsCsv,
  extractImportSessionMeta,
  getFailedQueueRows,
  type ImportRunSnapshot,
} from './import/importResultHelpers'
import { navigateToQualityPage } from './quality/qualityNav'
import {
  IconAlert,
  IconChartBars,
  IconChevronRight,
  IconClock,
  IconCompare,
  IconGrid,
  IconMiniCheck,
  IconMiniClock,
  IconMiniMap,
  IconMiniSteps,
  IconNetwork,
  IconPlusSquare,
  IconReportDoc,
  IconSettings,
  IconUpload,
  IconUser,
} from './design/navIcons'
import { canAccessNav, defaultNavForRole, isAdmin } from './users/rbacNav'
import { resolveOrgHierInitialMode } from './utils/navHelpers'
import { RbacProvider } from './users/rbacContext'

function formatCheckProgressHint(done: number, total: number) {
  return t.importUpload.formatCheckingWithProgress
    .replace(/\{done\}/g, String(done))
    .replace(/\{total\}/g, String(total))
}

/** 格式检测通过后的「可勾选 Sheet」上限（去重、排序，便于 Set 比对） */
function normalizeValidatedSheetScope(keys: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of keys) {
    const s = String(k).trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  out.sort((a, b) => a.localeCompare(b, 'zh-CN'))
  return out
}

/** 与页面 targetSig 计算方式一致，用于比对「格式检测通过瞬间」的勾选快照 */
function sheetKeysSignature(keys: string[]): string {
  return [...keys].sort((a, b) => a.localeCompare(b, 'zh-CN')).join('|')
}

/** 文件上传页与格式检测页「目标 Sheet」勾选区统一可视高度（超出部分内部滚动；相对原 96/104px 约矮 30%） */
const TARGET_SHEET_AREA_SCROLL_CLASS = 'max-h-[67px] overflow-y-auto pr-1 sm:max-h-[73px]'

type AppState =
  | { kind: 'logged_out' }
  | { kind: 'logged_in'; user: User; nav: NavKey; importHandoff: ImportWizardHandoff | null }

function LoginScreen(props: { onLogin: (user: User) => void; sessionExpired?: boolean }) {
  const demoBlankLogin = t.login.demoUsername === '' && t.login.demoPassword === ''
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  /** 演示空账号登录时默认关闭「记住我」，减少浏览器自动填充 admin 等已存密码 */
  const [remember, setRemember] = useState(!demoBlankLogin)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const doLogin = async (u: string, p: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await postAuthLogin({ username: u, password: p, remember })
      if (!res.ok || !res.user) {
        setError(res.error?.message ?? t.login.errorInvalid)
        return
      }
      props.onLogin({
        username: res.user.username,
        displayName: res.user.displayName,
        role: res.user.role,
        roleLabel: res.user.roleLabel,
      })
    } finally {
      setBusy(false)
    }
  }

  const loginAsDemo = () => {
    void doLogin('', '')
  }

  const submit = () => {
    void doLogin(username.trim(), password)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[linear-gradient(135deg,#f0f6ff,#e8f0fe_50%,#dceeff)]">
      {/* shapes: align invoicelens.html */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -right-20 -top-[100px] h-[480px] w-[480px] rounded-full bg-[#0066cc] opacity-[0.07]" />
        <div className="absolute -bottom-[60px] -left-[60px] h-[320px] w-[320px] rounded-full bg-[#0066cc] opacity-[0.07]" />
        <div className="absolute left-[20%] top-[40%] h-[180px] w-[180px] rounded-full bg-[#0066cc] opacity-[0.07]" />
      </div>

      <div className="relative w-[420px] max-w-[calc(100vw-32px)] rounded-[20px] bg-white px-11 pb-9 pt-11 shadow-[0_20px_60px_rgba(0,102,204,.12)]">
        {/* logo */}
        <div className="mb-1 flex items-center gap-[14px]">
          <img
            src="/app-icon.svg"
            alt={t.shell.appNameEn}
            className="h-[54px] w-[54px] select-none"
            draggable={false}
          />
          <div>
            <div className="text-il-login-brand font-bold text-accent">
              {t.shell.appNameEn}
            </div>
            <div className="mt-px text-il-page-desc text-text-2">{t.login.brandSub}</div>
          </div>
        </div>

        {/* sep */}
        <div className="mb-4 border-b border-border-light pb-[18px] text-il-page-desc text-text-3">
          {t.login.sep}
        </div>

        {props.sessionExpired ? (
          <p className="mb-4 rounded border border-warn/40 bg-[#fff9e9] px-3 py-2 text-il-page-desc text-[#8a6d00]">
            {t.common.sessionExpired}
          </p>
        ) : null}

        {/* demo tip */}
        <div className="mb-4 rounded-md border border-[#c8dff7] bg-[#f0f7ff] px-[13px] py-[9px] text-il-page-desc text-accent-mid">
          {t.login.demoTip}
        </div>

        {demoBlankLogin ? (
          <button
            type="button"
            className="mb-4 w-full rounded-[7px] border border-accent bg-white py-2.5 text-il-page-desc font-medium text-accent transition-colors hover:bg-[#f0f7ff]"
            disabled={busy}
          onClick={loginAsDemo}
          >
            {t.login.demoOneClick}
          </button>
        ) : null}

        <div className="mb-[13px]">
          <label className="mb-1 block text-il-page-desc font-medium text-text-2">{t.login.accountLabel}</label>
          <input
            className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-[13px] py-[9px] text-il-input leading-[1.5] text-text placeholder:text-text-3 outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:bg-white focus:shadow-[0_0_0_3px_rgba(0,114,209,.10)]"
            name="invoicelens_account"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t.login.accountPlaceholder}
            autoComplete={
              demoBlankLogin ? 'off' : remember ? 'username' : 'off'
            }
          />
        </div>
        <div className="mb-3">
          <label className="mb-1 block text-il-page-desc font-medium text-text-2">{t.login.passwordLabel}</label>
          <input
            type="password"
            className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-[13px] py-[9px] text-il-input leading-[1.5] text-text placeholder:text-text-3 outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:bg-white focus:shadow-[0_0_0_3px_rgba(0,114,209,.10)]"
            name="invoicelens_password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t.login.passwordPlaceholder}
            autoComplete={
              demoBlankLogin ? 'new-password' : remember ? 'current-password' : 'off'
            }
          />
        </div>

        <div className="mb-4 flex items-center justify-between text-il-page-desc text-text-2">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {t.login.remember}
          </label>
          <a
            className="text-accent no-underline"
            href="#"
            onClick={(e) => e.preventDefault()}
          >
            {t.login.forgotPassword}
          </a>
        </div>

        {error ? <div className="mb-3 text-il-page-desc text-danger">{error}</div> : null}
        <button
          className="w-full rounded-[7px] bg-[linear-gradient(135deg,#0088ff,#0055cc)] py-[11px] text-[15px] font-semibold text-white transition-opacity duration-150 hover:opacity-90"
          disabled={busy}
          onClick={submit}
        >
          {t.login.submit}
        </button>

        <div className="mt-[18px] text-center text-il-meta text-text-3">
          {t.login.footnote}
        </div>
      </div>
    </div>
  )
}

function Sidebar(props: {
  nav: NavKey
  onNav: (key: NavKey) => void
  user: User
  onLogout: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [pendingFlagCount, setPendingFlagCount] = useState<number | null>(null)
  const [relatedNavCount, setRelatedNavCount] = useState<number | null>(null)
  const [openParents, setOpenParents] = useState<Record<string, boolean>>({
    import: true,
    factory: false,
    dim: false,
    tax_analysis: false,
    overview: false,
    invoice_behavior: false,
    supplier: false,
    flags: false,
    related: false,
    finance: false,
    subject_evaluation: false,
    report: false,
    users: false,
    settings: false,
  })
  const [openChildren, setOpenChildren] = useState<Record<string, boolean>>({
    wizard: true,
    quality: false,
    mapping: false,
    processing: false,
    org: false,
    audited: false,
    tax: false,
    dict: false,
    compare: false,
  })

  useEffect(() => {
    if (props.nav !== 'import_mapping_config' && props.nav !== 'import_mapping_templates') return
    setOpenParents((p) => ({ ...p, import: true }))
    setOpenChildren((c) => ({ ...c, mapping: true }))
  }, [props.nav])

  useEffect(() => {
    if (props.nav !== 'processing_derived_dim_tasks') return
    setOpenParents((p) => ({ ...p, factory: true }))
    setOpenChildren((c) => ({ ...c, processing: true }))
  }, [props.nav])

  useEffect(() => {
    if (
      props.nav !== 'ods_to_dwd_center' &&
      props.nav !== 'dwd_to_dim_center' &&
      props.nav !== 'dwd_data_preview' &&
      props.nav !== 'import_history'
    )
      return
    setOpenParents((p) => ({ ...p, factory: true }))
    if (
      props.nav === 'ods_to_dwd_center' ||
      props.nav === 'dwd_to_dim_center' ||
      props.nav === 'dwd_data_preview'
    ) {
      setOpenChildren((c) => ({ ...c, processing: true }))
    }
  }, [props.nav])

  useEffect(() => {
    if (
      props.nav !== 'dim_enterprise_library' &&
      props.nav !== 'dim_audit_related_library' &&
      props.nav !== 'dim_level1_enterprise_year' &&
      props.nav !== 'dim_audited_registry' &&
      props.nav !== 'dim_enterprise_year_roster' &&
      props.nav !== 'dim_audited_contribution' &&
      props.nav !== 'dim_audited_invoice_link' &&
      props.nav !== 'dim_invoice_to_audited_enterprise' &&
      props.nav !== 'dim_org_sys' &&
      props.nav !== 'dim_org_hier_tree' &&
      props.nav !== 'dim_org_manage' &&
      props.nav !== 'dim_org_equity' &&
      props.nav !== 'dim_org_diff'
    )
      return
    setOpenParents((p) => ({ ...p, dim: true }))
    setOpenChildren((c) => ({ ...c, org: true }))
    if (
      props.nav === 'dim_audited_registry' ||
      props.nav === 'dim_enterprise_year_roster' ||
      props.nav === 'dim_audited_contribution' ||
      props.nav === 'dim_audited_invoice_link' ||
      props.nav === 'dim_invoice_to_audited_enterprise' ||
      props.nav === 'dim_level1_enterprise_year' ||
      props.nav === 'dim_org_hier_tree' ||
      props.nav === 'dim_org_manage' ||
      props.nav === 'dim_org_equity' ||
      props.nav === 'dim_org_diff'
    ) {
      setOpenChildren((c) => ({ ...c, audited: true }))
    }
  }, [props.nav])

  useEffect(() => {
    if (
      props.nav !== 'dim_tax_lib' &&
      props.nav !== 'dim_tax_risk_define' &&
      props.nav !== 'dim_tax_result' &&
      props.nav !== 'dim_tax_quality' &&
      props.nav !== 'dim_subject_category' &&
      props.nav !== 'dim_dict' &&
      props.nav !== 'dim_version'
    )
      return
    setOpenParents((p) => ({ ...p, dim: true }))
    if (props.nav === 'dim_subject_category' || props.nav === 'dim_dict') {
      setOpenChildren((c) => ({ ...c, dict: true }))
      return
    }
    if (props.nav === 'dim_version') return
    setOpenChildren((c) => ({ ...c, tax: true }))
  }, [props.nav])

  useEffect(() => {
    if (
      props.nav !== 'tax_enterprise_structure' &&
      props.nav !== 'tax_in_out_deviation' &&
      props.nav !== 'tax_risk_exposure' &&
      props.nav !== 'goods_category'
    )
      return
    setOpenParents((p) => ({ ...p, tax_analysis: true }))
  }, [props.nav])

  useEffect(() => {
    if (
      props.nav !== 'overview_summary' &&
      props.nav !== 'overview_trend' &&
      props.nav !== 'overview_tax'
    )
      return
    setOpenParents((p) => ({ ...p, overview: true }))
  }, [props.nav])

  useEffect(() => {
    if (props.nav !== 'red_offset_analysis' && props.nav !== 'invoice_timing') return
    setOpenParents((p) => ({ ...p, invoice_behavior: true }))
  }, [props.nav])

  useEffect(() => {
    if (props.nav !== 'related_graph' && props.nav !== 'related_pairs' && props.nav !== 'related_shell') return
    setOpenParents((p) => ({ ...p, related: true }))
  }, [props.nav])

  useEffect(() => {
    const ac = new AbortController()
    void fetchAuditPendingCount(undefined, ac.signal).then((res) => {
      if (ac.signal.aborted || !res.ok) return
      setPendingFlagCount(res.pending ?? 0)
    })
    return () => ac.abort()
  }, [props.nav])

  useEffect(() => {
    const ac = new AbortController()
    const year = String(new Date().getFullYear())
    void fetchAuditRelatedNavCount(year, ac.signal).then((res) => {
      if (ac.signal.aborted || !res.ok) return
      setRelatedNavCount(res.total ?? 0)
    })
    return () => ac.abort()
  }, [props.nav])

  useEffect(() => {
    if (
      props.nav !== 'flags_list' &&
      props.nav !== 'flags_rules' &&
      props.nav !== 'flags_track'
    )
      return
    setOpenParents((p) => ({ ...p, flags: true }))
  }, [props.nav])

  useEffect(() => {
    if (props.nav !== 'import_invoice_export') return
    setOpenParents((p) => ({ ...p, import: true }))
  }, [props.nav])

  useEffect(() => {
    if (props.nav !== 'report_config' && props.nav !== 'report_archive' && props.nav !== 'report_templates') return
    setOpenParents((p) => ({ ...p, report: true }))
  }, [props.nav])

  useEffect(() => {
    if (
      props.nav !== 'supplier_cr' &&
      props.nav !== 'supplier_top' &&
      props.nav !== 'supplier_new' &&
      props.nav !== 'trade_relationships' &&
      props.nav !== 'counterparty_risk'
    )
      return
    setOpenParents((p) => ({ ...p, supplier: true }))
  }, [props.nav])

  useEffect(() => {
    if (props.nav !== 'finance_reconcile' && props.nav !== 'finance_diff') return
    setOpenParents((p) => ({ ...p, finance: true }))
  }, [props.nav])

  useEffect(() => {
    if (props.nav !== 'health_score' && props.nav !== 'entity_profile') return
    setOpenParents((p) => ({ ...p, subject_evaluation: true }))
  }, [props.nav])

  useEffect(() => {
    if (
      props.nav !== 'year_over_year_compare' &&
      props.nav !== 'compare_rank' &&
      props.nav !== 'compare_charts'
    )
      return
    setOpenParents((p) => ({ ...p, subject_evaluation: true }))
    if (props.nav === 'compare_rank' || props.nav === 'compare_charts') {
      setOpenChildren((c) => ({ ...c, compare: true }))
    }
  }, [props.nav])

  useEffect(() => {
    if (
      props.nav !== 'import_quality_overview' &&
      props.nav !== 'import_quality_detail' &&
      props.nav !== 'import_quality_trend'
    )
      return
    setOpenParents((p) => ({ ...p, factory: true }))
    setOpenChildren((c) => ({ ...c, quality: true }))
  }, [props.nav])

  const toggleParent = (k: string) => {
    setOpenParents((p) => ({ ...p, [k]: !p[k] }))
  }

  const toggleChild = (k: string) => {
    setOpenChildren((p) => ({ ...p, [k]: !p[k] }))
  }

  const sidebarLeafDot = <span className="block h-1 w-1 flex-shrink-0 rounded-full bg-text-3/50" />

  const navParentPanel = (parentKey: string, body: React.ReactNode) => {
    if (!openParents[parentKey] || collapsed) return null
    return (
      <div className="mx-1.5 mb-1 rounded-md border border-accent/10 bg-[#ebf2fa] py-0.5">
        {body}
      </div>
    )
  }

  const navParent = (k: string, label: string, icon: React.ReactNode, badge?: React.ReactNode) => {
    const open = !!openParents[k]
    return (
      <div
        className={[
          'flex items-center gap-2 px-3 py-[7px] text-il-sidebar-parent text-text-2',
          'cursor-pointer select-none overflow-hidden whitespace-nowrap',
          'border-l-2 border-l-transparent transition-[background,color] duration-100',
          open ? 'bg-[#e3edf9]/80 font-semibold text-text' : 'font-medium',
          'hover:bg-[#eef4fc] hover:text-text',
          collapsed ? 'justify-center px-0' : '',
        ].join(' ')}
        onClick={() => toggleParent(k)}
        title={collapsed ? label : undefined}
      >
        <span className={['h-[15px] w-[15px] flex-shrink-0', open ? 'opacity-100' : 'opacity-60'].join(' ')}>
          {icon}
        </span>
        <span className={['flex-1 overflow-hidden text-ellipsis', collapsed ? 'opacity-0 w-0 flex-none' : ''].join(' ')}>
          {label}
        </span>
        {badge && !collapsed ? badge : null}
        {!collapsed ? (
          <IconChevronRight
            className={['h-[12px] w-[12px] flex-shrink-0 opacity-45 transition-transform duration-200', open ? 'rotate-90' : ''].join(' ')}
          />
        ) : null}
      </div>
    )
  }

  const navChildNav = (
    navKey: NavKey,
    slug: string,
    label: string,
    icon: React.ReactNode,
    opts?: {
      soon?: boolean
      active?: boolean
    },
  ) => {
    if (!canAccessNav(props.user.role, navKey)) return null
    return navChild(slug, label, icon, {
      ...opts,
      active: opts?.active ?? props.nav === navKey,
      onClick: () => props.onNav(navKey),
    })
  }

  const navChildDeepNav = (
    navKey: NavKey,
    slug: string,
    label: string,
    icon: React.ReactNode,
    opts?: {
      soon?: boolean
      active?: boolean
    },
  ) => {
    if (!canAccessNav(props.user.role, navKey)) return null
    return navChildDeep(slug, label, icon, {
      ...opts,
      active: opts?.active ?? props.nav === navKey,
      onClick: () => props.onNav(navKey),
    })
  }

  const navChild = (
    k: string,
    label: string,
    icon: React.ReactNode,
    opts?: {
      openable?: boolean
      open?: boolean
      soon?: boolean
      onClick?: () => void
      /** 叶子项选中态（与 navGrand 高亮一致；不与 openable 同用） */
      active?: boolean
    },
  ) => {
    const openable = !!opts?.openable
    const open = !!opts?.open
    const soon = !!opts?.soon
    const onClick = opts?.onClick
    const active = !!opts?.active && !openable && !soon
    const leafWeight = openable ? 'font-medium' : active ? 'font-medium' : 'font-normal'
    return (
      <div
        className={[
          'relative flex items-center gap-1.5 px-3 py-[6px] pl-9 text-il-sidebar-child',
          leafWeight,
          'cursor-pointer overflow-hidden whitespace-nowrap',
          'border-l-2 transition-[background,color,border-color] duration-100',
          active ? 'border-l-accent bg-[#EBF4FF] text-accent' : 'border-l-transparent text-text-2',
          active ? '' : 'hover:bg-[#f5f7ff] hover:text-text',
          soon ? 'opacity-45 cursor-default hover:bg-transparent hover:text-text-2' : '',
        ].join(' ')}
        onClick={() => {
          if (soon) return
          if (openable) toggleChild(k)
          else onClick?.()
        }}
        title={collapsed ? label : undefined}
      >
        <span className="absolute left-5 top-1/2 h-px w-[7px] -translate-y-1/2 bg-border-light" />
        <span className={['h-[11px] w-[11px] flex-shrink-0', active ? 'opacity-100' : 'opacity-65'].join(' ')}>{icon}</span>
        <span className="flex-1 overflow-hidden text-ellipsis">{label}</span>
        {openable ? (
          <IconChevronRight className={['h-[10px] w-[10px] flex-shrink-0 opacity-40 transition-transform duration-200', open ? 'rotate-90' : ''].join(' ')} />
        ) : null}
        {soon ? (
          <span className="ml-1 rounded border border-border-light px-1 text-il-soon text-text-3">
            {t.common.soon}
          </span>
        ) : null}
      </div>
    )
  }

  /** 三级可展开/叶子入口（企业组织维度下，与 navChild 同级逻辑、更深缩进） */
  const navChildDeep = (
    k: string,
    label: string,
    icon: React.ReactNode,
    opts?: {
      openable?: boolean
      open?: boolean
      soon?: boolean
      onClick?: () => void
      active?: boolean
    },
  ) => {
    const openable = !!opts?.openable
    const open = !!opts?.open
    const soon = !!opts?.soon
    const onClick = opts?.onClick
    const active = !!opts?.active && !openable && !soon
    const leafWeight = openable ? 'font-medium' : active ? 'font-medium' : 'font-normal'
    return (
      <div
        className={[
          'relative flex cursor-pointer items-center gap-1.5 px-3 py-[6px] pl-[52px] text-il-sidebar-child',
          leafWeight,
          'overflow-hidden whitespace-nowrap border-l-2 transition-[background,color,border-color] duration-100',
          active ? 'border-l-accent bg-[#EBF4FF] text-accent' : 'border-l-transparent text-text-2',
          active ? '' : 'hover:bg-[#f5f7ff] hover:text-text',
          soon ? 'cursor-default opacity-45 hover:bg-transparent hover:text-text-2' : '',
        ].join(' ')}
        onClick={() => {
          if (soon) return
          if (openable) toggleChild(k)
          else onClick?.()
        }}
        title={collapsed ? label : undefined}
      >
        <span className="absolute bottom-0 left-[36px] top-0 w-px bg-border-light" />
        <span className="absolute left-[36px] top-1/2 h-px w-[10px] -translate-y-1/2 bg-border-light" />
        <span className={['absolute left-[46px] flex h-[11px] w-[11px] items-center justify-center', active ? 'opacity-100' : 'opacity-65'].join(' ')}>
          {icon}
        </span>
        <span className="flex-1 overflow-hidden text-ellipsis pl-[14px]">{label}</span>
        {openable ? (
          <IconChevronRight className={['h-[10px] w-[10px] flex-shrink-0 opacity-40 transition-transform duration-200', open ? 'rotate-90' : ''].join(' ')} />
        ) : null}
        {soon ? (
          <span className="ml-1 rounded border border-border-light px-1 text-il-soon text-text-3">
            {t.common.soon}
          </span>
        ) : null}
      </div>
    )
  }

  /** 被审企业组织内不可点击的分组小标题（与 tier: great 叶子同缩进） */
  const navGroupLabel = (label: string, opts?: { first?: boolean }) => {
    if (collapsed) return null
    return (
      <div
        className={['relative select-none pointer-events-none', opts?.first ? '' : 'mt-1'].join(' ')}
        aria-hidden
      >
        <span className="absolute bottom-0 left-[52px] top-0 w-px bg-border-light" />
        {!opts?.first ? (
          <div className="ml-[56px] mr-3 border-t border-border-light/90" aria-hidden />
        ) : null}
        <div className="flex items-center gap-1.5 pl-[56px] pr-3 pb-[1px] pt-[5px]">
          <span className="h-[10px] w-[2px] flex-shrink-0 rounded-full bg-accent/35" aria-hidden />
          <span className="text-[9px] font-semibold tracking-[.14em] text-text-3/65">{label}</span>
        </div>
      </div>
    )
  }

  const navGrand = (
    key: NavKey,
    label: string,
    opts?: {
      active?: boolean
      soon?: boolean
      /** 开发迭代中：可进入页面，侧栏显示「开发中」徽标 */
      inProgress?: boolean
      /** 可选：与同级「·」区分层级或能力类型 */
      icon?: React.ReactNode
      /** 四级叶子（如被审企业组织下）；默认与税收分类等三级子项一致 */
      tier?: 'default' | 'great'
    },
  ) => {
    if (!canAccessNav(props.user.role, key)) return null
    const active = !!opts?.active
    const soon = !!opts?.soon
    const inProgress = !!opts?.inProgress && !soon
    const rowIcon = opts?.icon
    const great = opts?.tier === 'great'
    const padLeft = great ? 'pl-[72px]' : 'pl-[52px]'
    const trunkLeft = great ? 'left-[52px]' : 'left-[36px]'
    const iconLeft = great ? 'left-[62px]' : 'left-[46px]'
    const dotLeft = great ? 'left-[64px]' : 'left-[48px]'
    return (
      <div
        className={[
          'relative flex cursor-pointer items-center px-3 py-[5px] text-il-sidebar-grand text-text-3',
          padLeft,
          'border-l-2 border-l-transparent transition-[background,color] duration-100 overflow-hidden whitespace-nowrap',
          active ? 'bg-[#EBF4FF] text-accent border-l-accent font-medium' : 'hover:bg-[#f5f7ff] hover:text-text-2',
          soon ? 'opacity-45 cursor-default hover:bg-transparent hover:text-text-3' : '',
        ].join(' ')}
        onClick={() => {
          if (soon) return
          props.onNav(key)
        }}
      >
        <span className={['absolute bottom-0 top-0 w-px bg-border-light', trunkLeft].join(' ')} />
        <span className={['absolute top-1/2 h-px w-[10px] -translate-y-1/2 bg-border-light', trunkLeft].join(' ')} />
        {rowIcon ? (
          <span className={['absolute flex h-[11px] w-[11px] items-center justify-center', iconLeft, active ? 'opacity-100' : 'opacity-65'].join(' ')}>
            {rowIcon}
          </span>
        ) : (
          <span className={['absolute text-border', dotLeft].join(' ')}>·</span>
        )}
        <span className={['flex-1 overflow-hidden text-ellipsis', rowIcon ? 'pl-[14px]' : ''].join(' ')}>{label}</span>
        {soon ? (
          <span className="ml-1 rounded border border-border-light px-1 text-il-soon text-text-3">
            {t.common.soon}
          </span>
        ) : inProgress ? (
          <span className="ml-1 rounded border border-[#e8d4a8] bg-[#fff9e9] px-1 text-il-soon text-[#8a6d00]">
            {t.common.inProgress}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div className={['flex flex-col overflow-hidden border-r border-border-light bg-white transition-[width] duration-200', collapsed ? 'w-[48px]' : 'w-[240px]'].join(' ')}>
      <div className="relative">
        <div className="flex items-center gap-2 border-b border-border-light px-3 py-3 overflow-hidden">
        <img
          src="/app-icon.svg"
          alt={t.shell.appNameEn}
          className="h-[30px] w-[30px] select-none"
          draggable={false}
        />
          <div className={['min-w-0 transition-opacity duration-150', collapsed ? 'opacity-0 w-0' : 'opacity-100'].join(' ')}>
            <div className="text-[13px] font-bold text-accent">{t.shell.appNameEn}</div>
            <div className="text-il-pill text-text-3">{t.shell.brandSub}</div>
          </div>
        </div>
        {/* collapse btn */}
        <div
          className="absolute -right-[11px] top-1/2 flex h-[22px] w-[22px] -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-white text-il-pill text-text-2"
          title={t.shell.sidebarCollapseTitle}
          onClick={() => setCollapsed((v) => !v)}
        >
          <span className={['inline-block transition-transform duration-200', collapsed ? 'rotate-180' : ''].join(' ')}>
            ◀
          </span>
        </div>
      </div>
      <div className={['flex-1 overflow-y-auto overflow-x-hidden py-1', collapsed ? 'overflow-hidden' : ''].join(' ')}>
        <div className={['px-[14px] py-[6px] text-il-pill font-semibold tracking-[.07em] text-text-3', collapsed ? 'opacity-0' : ''].join(' ')}>
          {t.sidebar.sectionPrep}
        </div>

        {navParent('import', t.sidebar.invoiceData, <IconUpload className="h-[15px] w-[15px]" />)}
        {navParentPanel(
          'import',
          <>
            {navChild(
              'mapping',
              t.sidebar.fieldMapping,
              <IconMiniMap className="h-[11px] w-[11px]" />,
              { openable: true, open: !!openChildren.mapping },
            )}
            <div className={openChildren.mapping ? 'block' : 'hidden'}>
              {navGrand('import_mapping_config', t.sidebar.mappingConfig, {
                active: props.nav === 'import_mapping_config',
              })}
              {navGrand('import_mapping_templates', t.sidebar.mappingTemplates, {
                active: props.nav === 'import_mapping_templates',
              })}
            </div>
            {navChild(
              'wizard',
              t.sidebar.importWizard,
              <IconMiniSteps className="h-[11px] w-[11px]" />,
              { openable: true, open: !!openChildren.wizard },
            )}
            <div className={openChildren.wizard ? 'block' : 'hidden'}>
              {navGrand('import_wizard_format_check', t.sidebar.formatCheck, {
                active: props.nav === 'import_wizard_format_check',
              })}
              {navGrand('import_wizard_upload', t.sidebar.fileUpload, { active: props.nav === 'import_wizard_upload' })}
              {navGrand('import_wizard_ods_overview', t.sidebar.odsOverview, {
                active: props.nav === 'import_wizard_ods_overview',
              })}
              {navGrand('import_wizard_preview', t.sidebar.dataPreview, { active: props.nav === 'import_wizard_preview' })}
            </div>
            {navChildNav('import_invoice_export', 'export', t.sidebar.invoiceExport, <IconReportDoc className="h-[11px] w-[11px]" />)}
          </>,
        )}

        {navParent(
          'dim',
          t.sidebar.dimMgmt,
          <IconGrid className="h-[15px] w-[15px]" />,
          !collapsed ? (
            <span className="rounded-full bg-accent px-1.5 py-[1px] text-il-soon font-semibold text-white">
              {t.sidebar.badgeNew}
            </span>
          ) : null,
        )}
        {navParentPanel(
          'dim',
          <>
            {navChild('org', t.sidebar.dimOrg, <IconMiniMap className="h-[11px] w-[11px]" />, { openable: true, open: !!openChildren.org })}
            <div className={openChildren.org ? 'block' : 'hidden'}>
              {navChildDeepNav(
                'dim_org_sys',
                'org_sys',
                t.sidebar.dimOrgSys,
                <IconMiniMap className="h-[11px] w-[11px]" />,
                { active: props.nav === 'dim_org_sys' },
              )}
              {navChildDeep('audited', t.sidebar.dimAuditedEnterprise, <IconNetwork className="h-[11px] w-[11px]" />, {
                openable: true,
                open: !!openChildren.audited,
              })}
              <div className={openChildren.audited ? 'block' : 'hidden'}>
                {navGroupLabel(t.sidebar.dimAuditedGroupRegistry, { first: true })}
                {navGrand('dim_audited_registry', t.sidebar.dimAuditedLedger, {
                  active: props.nav === 'dim_audited_registry',
                  tier: 'great',
                })}
                {navGrand('dim_audited_contribution', t.sidebar.dimAuditedContribution, {
                  active: props.nav === 'dim_audited_contribution',
                  tier: 'great',
                })}
                {navGroupLabel(t.sidebar.dimAuditedGroupYearScope)}
                {navGrand('dim_level1_enterprise_year', t.sidebar.dimLevel1EnterpriseYear, {
                  active: props.nav === 'dim_level1_enterprise_year',
                  tier: 'great',
                })}
                {navGrand('dim_enterprise_year_roster', t.sidebar.dimEnterpriseYearRoster, {
                  active: props.nav === 'dim_enterprise_year_roster',
                  tier: 'great',
                })}
                {navGroupLabel(t.sidebar.dimAuditedGroupHierView)}
                {navGrand('dim_org_hier_tree', t.sidebar.dimOrgHierTree, {
                  active:
                    props.nav === 'dim_org_hier_tree' ||
                    props.nav === 'dim_org_manage' ||
                    props.nav === 'dim_org_equity' ||
                    props.nav === 'dim_org_diff',
                  tier: 'great',
                })}
                {navGroupLabel(t.sidebar.dimAuditedGroupInvoiceAlign)}
                {navGrand('dim_audited_invoice_link', t.sidebar.dimInvoiceLink, {
                  active: props.nav === 'dim_audited_invoice_link',
                  tier: 'great',
                })}
                {navGrand('dim_invoice_to_audited_enterprise', t.sidebar.dimInvoiceToAudited, {
                  active: props.nav === 'dim_invoice_to_audited_enterprise',
                  tier: 'great',
                })}
              </div>
              {navChildDeepNav(
                'dim_audit_related_library',
                'audit_related_coverage',
                t.sidebar.dimAuditRelatedLibrary,
                <IconCompare className="h-[11px] w-[11px]" />,
                { active: props.nav === 'dim_audit_related_library' },
              )}
              {navChildDeepNav(
                'dim_enterprise_library',
                'enterprise_library',
                t.sidebar.dimEnterpriseLibrary,
                <IconUser className="h-[11px] w-[11px]" />,
                { active: props.nav === 'dim_enterprise_library' },
              )}
            </div>
            {navChild('tax', t.sidebar.dimTaxCode, <IconPlusSquare className="h-[11px] w-[11px]" />, { openable: true, open: !!openChildren.tax })}
            <div className={openChildren.tax ? 'block' : 'hidden'}>
              {navGrand('dim_tax_lib', t.sidebar.dimTaxLib, {
                active: props.nav === 'dim_tax_lib',
              })}
              {navGrand('dim_tax_risk_define', t.sidebar.dimTaxRiskDefine, {
                active: props.nav === 'dim_tax_risk_define',
              })}
              {navGrand('dim_tax_result', t.sidebar.dimTaxResult, {
                active: props.nav === 'dim_tax_result',
              })}
              {navGrand('dim_tax_quality', t.sidebar.dimTaxQuality, {
                active: props.nav === 'dim_tax_quality',
              })}
            </div>
            {navChild('dict', t.sidebar.dimDict, <IconPlusSquare className="h-[11px] w-[11px]" />, {
              openable: true,
              open: !!openChildren.dict,
            })}
            <div className={openChildren.dict ? 'block' : 'hidden'}>
              {navGrand('dim_dict', t.sidebar.dimDictHub, {
                active: props.nav === 'dim_dict',
              })}
              {navGrand('dim_subject_category', t.sidebar.dimSubjectCategory, {
                active: props.nav === 'dim_subject_category',
              })}
            </div>
            {navChildNav('dim_version', 'ver', t.sidebar.dimVersion, <IconMiniClock className="h-[11px] w-[11px]" />)}
          </>,
        )}

        {navParent('factory', t.sidebar.dataFactory, <IconCompare className="h-[15px] w-[15px]" />)}
        {navParentPanel(
          'factory',
          <>
            {navChild('processing', t.sidebar.processingCenter, <IconCompare className="h-[11px] w-[11px]" />, {
              openable: true,
              open: !!openChildren.processing,
            })}
            <div className={openChildren.processing ? 'block' : 'hidden'}>
              {navGrand('ods_to_dwd_center', t.sidebar.odsToDwd, {
                active: props.nav === 'ods_to_dwd_center',
              })}
              {navGrand('dwd_to_dim_center', t.sidebar.dwdToDim, {
                active: props.nav === 'dwd_to_dim_center',
              })}
              {navGrand('dwd_data_preview', t.sidebar.dwdDataPreview, {
                active: props.nav === 'dwd_data_preview',
              })}
              {navGrand('processing_derived_dim_tasks', t.sidebar.processingDerivedDimTasks, {
                active: props.nav === 'processing_derived_dim_tasks',
              })}
            </div>
            {navChildNav('import_history', 'history', t.sidebar.historyBatches, <IconMiniClock className="h-[11px] w-[11px]" />)}
            {navChild(
              'quality',
              t.sidebar.qualityReport,
              <IconMiniCheck className="h-[11px] w-[11px]" />,
              { openable: true, open: !!openChildren.quality },
            )}
            <div className={openChildren.quality ? 'block' : 'hidden'}>
              {navGrand('import_quality_overview', t.sidebar.qualityOverview, {
                active: props.nav === 'import_quality_overview',
              })}
              {navGrand('import_quality_detail', t.sidebar.qualityDetail, {
                active: props.nav === 'import_quality_detail',
              })}
              {navGrand('import_quality_trend', t.sidebar.qualityTrend, {
                active: props.nav === 'import_quality_trend',
              })}
            </div>
          </>,
        )}

        <div className="my-1 border-t border-border-light" />

        <div className={['px-[14px] py-[6px] text-il-pill font-semibold tracking-[.07em] text-text-3', collapsed ? 'opacity-0' : ''].join(' ')}>
          {t.sidebar.sectionAnalysis}
        </div>

        {navParent('overview', t.sidebar.overview, <IconChartBars className="h-[15px] w-[15px]" />)}
        {navParentPanel(
          'overview',
          <>
            {navChildNav('overview_summary', 'ov1', t.sidebar.ovSummary, sidebarLeafDot)}
            {navChildNav('overview_trend', 'ov2', t.sidebar.ovTrend, sidebarLeafDot)}
            {navChildNav('overview_tax', 'ov3', t.sidebar.ovTax, sidebarLeafDot)}
          </>,
        )}

        {navParent('subject_evaluation', t.sidebar.subjectEvaluation, <IconUser className="h-[15px] w-[15px]" />)}
        {navParentPanel(
          'subject_evaluation',
          <>
            {navChildNav('health_score', 'se1', t.sidebar.healthScore, sidebarLeafDot)}
            {navChildNav('entity_profile', 'se2', t.sidebar.entityProfile, sidebarLeafDot)}
            {navChild('compare', t.sidebar.compare, sidebarLeafDot, {
              openable: true,
              open: !!openChildren.compare,
            })}
            {openChildren.compare ? (
              <>
                {navChildDeepNav('compare_rank', 'c1', t.sidebar.compareRank, sidebarLeafDot)}
                {navChildDeepNav('compare_charts', 'c2', t.sidebar.compareCharts, sidebarLeafDot)}
              </>
            ) : null}
            {navChildNav('year_over_year_compare', 'yoy1', t.sidebar.yearOverYearCompare, sidebarLeafDot)}
          </>,
        )}

        {navParent('tax_analysis', t.sidebar.taxAnalysis, <IconChartBars className="h-[15px] w-[15px]" />)}
        {navParentPanel(
          'tax_analysis',
          <>
            {navChildNav('tax_enterprise_structure', 'ta1', t.sidebar.taxEnterpriseStructure, sidebarLeafDot)}
            {navChildNav('tax_in_out_deviation', 'ta2', t.sidebar.taxInOutDeviation, sidebarLeafDot)}
            {navChildNav('tax_risk_exposure', 'ta3', t.sidebar.taxRiskExposure, sidebarLeafDot)}
            {navChildNav('goods_category', 'ta4', t.sidebar.goodsCategory, sidebarLeafDot)}
          </>,
        )}

        {navParent('supplier', t.sidebar.supplier, <IconClock className="h-[15px] w-[15px]" />)}
        {navParentPanel(
          'supplier',
          <>
            {navChildNav('supplier_cr', 's1', t.sidebar.supplierCr, sidebarLeafDot)}
            {navChildNav('supplier_top', 's2', t.sidebar.supplierTop, sidebarLeafDot)}
            {navChildNav('supplier_new', 's3', t.sidebar.supplierNew, sidebarLeafDot)}
            {navChildNav('trade_relationships', 's4', t.sidebar.tradeRelationships, sidebarLeafDot)}
            {navChildNav('counterparty_risk', 's5', t.sidebar.counterpartyRisk, sidebarLeafDot)}
          </>,
        )}

        {navParent(
          'related',
          t.sidebar.related,
          <IconNetwork className="h-[15px] w-[15px]" />,
          !collapsed && relatedNavCount != null && relatedNavCount > 0 ? (
            <span className="rounded-full bg-warn px-1.5 py-[1px] text-il-soon font-semibold text-white">
              {relatedNavCount > 99 ? '99+' : relatedNavCount}
            </span>
          ) : null,
        )}
        {navParentPanel(
          'related',
          <>
            {navChildNav('related_graph', 'r1', t.sidebar.relatedGraph, sidebarLeafDot)}
            {navChildNav('related_pairs', 'r2', t.sidebar.relatedPairs, sidebarLeafDot)}
            {navChildNav('related_shell', 'r3', t.sidebar.relatedShell, sidebarLeafDot)}
          </>,
        )}

        {navParent('invoice_behavior', t.sidebar.invoiceBehavior, <IconMiniClock className="h-[15px] w-[15px]" />)}
        {navParentPanel(
          'invoice_behavior',
          <>
            {navChildNav('red_offset_analysis', 'ib1', t.sidebar.redOffsetAnalysis, sidebarLeafDot)}
            {navChildNav('invoice_timing', 'ib2', t.sidebar.invoiceTiming, sidebarLeafDot)}
          </>,
        )}

        {navParent('finance', t.sidebar.finance, <IconReportDoc className="h-[15px] w-[15px]" />)}
        {navParentPanel(
          'finance',
          <>
            {navChildNav('finance_reconcile', 'j1', t.sidebar.financeReconcile, sidebarLeafDot)}
            {navChildNav('finance_diff', 'j2', t.sidebar.financeDiff, sidebarLeafDot)}
          </>,
        )}

        {navParent(
          'flags',
          t.sidebar.flags,
          <IconAlert className="h-[15px] w-[15px]" />,
          !collapsed && pendingFlagCount != null && pendingFlagCount > 0 ? (
            <span className="rounded-full bg-danger px-1.5 py-[1px] text-il-soon font-semibold text-white">
              {pendingFlagCount > 99 ? '99+' : pendingFlagCount}
            </span>
          ) : null,
        )}
        {navParentPanel(
          'flags',
          <>
            {navChildNav('flags_list', 'f1', t.sidebar.flagsList, sidebarLeafDot)}
            {navChildNav('flags_rules', 'f2', t.sidebar.flagsRules, sidebarLeafDot)}
            {navChildNav('flags_track', 'f3', t.sidebar.flagsTrack, sidebarLeafDot)}
          </>,
        )}

        <div className="my-1 border-t border-border-light" />

        <div className={['px-[14px] py-[6px] text-il-pill font-semibold tracking-[.07em] text-text-3', collapsed ? 'opacity-0' : ''].join(' ')}>
          {t.sidebar.sectionOutput}
        </div>

        {canAccessNav(props.user.role, 'report_config') ? (
          <>
            {navParent('report', t.sidebar.report, <IconReportDoc className="h-[15px] w-[15px]" />)}
            {navParentPanel(
              'report',
              <>
                {navChildNav('report_config', 'rp1', t.sidebar.reportConfig, sidebarLeafDot)}
                {navChildNav('report_templates', 'rp2', t.sidebar.reportTemplates, sidebarLeafDot)}
                {navChildNav('report_archive', 'rp3', t.sidebar.reportArchive, sidebarLeafDot)}
              </>,
            )}
          </>
        ) : null}

        <div className="my-1 border-t border-border-light" />

        <div className={['px-[14px] py-[6px] text-il-pill font-semibold tracking-[.07em] text-text-3', collapsed ? 'opacity-0' : ''].join(' ')}>
          {t.sidebar.sectionSystem}
        </div>

        {isAdmin(props.user.role) ? (
          <>
            {navParent('users', t.sidebar.users, <IconUser className="h-[15px] w-[15px]" />)}
            {navParentPanel(
              'users',
              <>
                {navChildNav('users_list', 'u1', t.sidebar.usersList, sidebarLeafDot)}
                {navChildNav('users_roles', 'u2', t.sidebar.usersRoles, sidebarLeafDot)}
                {navChildNav('users_audit', 'u3', t.sidebar.usersAudit, sidebarLeafDot)}
              </>,
            )}
          </>
        ) : null}

        {navParent('settings', t.sidebar.settings, <IconSettings className="h-[15px] w-[15px]" />)}
        {navParentPanel(
          'settings',
          <>
            {navChildNav('settings_thresholds', 'st1', t.sidebar.settingsThresholds, sidebarLeafDot)}
            {navChildNav('settings_license', 'st2', t.sidebar.settingsLicense, sidebarLeafDot)}
            {navChildNav('settings_instance', 'st3', t.sidebar.settingsInstance, sidebarLeafDot, {
              active: props.nav === 'settings_instance',
            })}
          </>,
        )}
      </div>
      <div className="border-t border-border-light px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="flex h-[27px] w-[27px] items-center justify-center rounded-full bg-[linear-gradient(135deg,#c8dff7,#9cc5f0)] text-il-meta font-semibold text-accent-mid">
            {props.user.displayName.slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium text-text">
              {props.user.displayName}
            </div>
            <div className="text-il-pill text-text-3">{props.user.roleLabel ?? props.user.role}</div>
          </div>
          <button
            className="rounded border border-border-light px-2 py-0.5 text-il-meta text-text-3 hover:border-danger hover:text-danger"
            onClick={props.onLogout}
          >
            {t.common.logout}
          </button>
        </div>
      </div>
    </div>
  )
}

const LS_MAX_UPLOAD_MB = 'invoicelens.maxUploadMb'
const LS_AUTO_IMPORT_AFTER_FORMAT = 'invoicelens.autoImportAfterFormat'
const LS_AUTO_DWD_AFTER_IMPORT = 'invoicelens.autoDwdAfterImport'
const LS_REBUILD_REL_AFTER_DWD = 'invoicelens.rebuildEnterpriseYearRelAfterDwd'

function readStoredMaxUploadMb(): number {
  try {
    const v = Number(localStorage.getItem(LS_MAX_UPLOAD_MB))
    if (Number.isFinite(v) && v >= 1) return Math.min(2048, Math.floor(v))
  } catch {
    /* ignore */
  }
  return MAX_IMPORT_FILE_MB
}

function readStoredAutoImportAfterFormat(): boolean {
  try {
    const raw = localStorage.getItem(LS_AUTO_IMPORT_AFTER_FORMAT)
    if (raw == null) return true
    const v = String(raw).trim().toLowerCase()
    if (v === '0' || v === 'false' || v === 'no') return false
    if (v === '1' || v === 'true' || v === 'yes') return true
  } catch {
    /* ignore */
  }
  return true
}

function readStoredAutoDwdAfterImport(): boolean {
  try {
    const raw = localStorage.getItem(LS_AUTO_DWD_AFTER_IMPORT)
    if (raw == null) return false
    const v = String(raw).trim().toLowerCase()
    if (v === '0' || v === 'false' || v === 'no') return false
    if (v === '1' || v === 'true' || v === 'yes') return true
  } catch {
    /* ignore */
  }
  return false
}

function readStoredRebuildRelAfterDwd(): boolean {
  try {
    const raw = localStorage.getItem(LS_REBUILD_REL_AFTER_DWD)
    if (raw == null) return false
    const v = String(raw).trim().toLowerCase()
    if (v === '0' || v === 'false' || v === 'no') return false
    if (v === '1' || v === 'true' || v === 'yes') return true
  } catch {
    /* ignore */
  }
  return false
}

/** 本地日历日，批次基准日期用 YYYYMMDD（与导入 API batch_id 一致） */
function yyyymmddTodayLocal(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function apiEventToImportEvent(raw: ApiImportEvent): ImportEvent {
  return {
    import_session_id: raw.import_session_id,
    event_id: Number(raw.event_id),
    ts: raw.ts,
    type: raw.type,
    payload: raw.payload,
  } as ImportEvent
}

function Topbar(props: { breadcrumb: React.ReactNode }) {
  const [licenseTag, setLicenseTag] = useState<string>(t.shell.licenseTag)

  useEffect(() => {
    const ac = new AbortController()
    const refreshLicenseTag = () => {
      void fetchLicenseInfo(ac.signal).then((res) => {
        if (ac.signal.aborted || !res.ok || !res.license) return
        const lic = res.license
        const tier =
          lic.tier === 'pro' || lic.tier === 'professional'
            ? '专业版'
            : lic.tier === 'enterprise'
              ? '企业版'
              : lic.tier === 'trial'
                ? '试用版'
                : lic.tier || '授权'
        const exp = lic.expiresAt ? ` · 有效期 ${lic.expiresAt}` : ''
        const expired = lic.isExpired ? ' · 已过期' : ''
        setLicenseTag(`${tier}${exp}${expired}`)
      })
    }
    refreshLicenseTag()
    window.addEventListener(LICENSE_UPDATED_EVENT, refreshLicenseTag)
    return () => {
      ac.abort()
      window.removeEventListener(LICENSE_UPDATED_EVENT, refreshLicenseTag)
    }
  }, [])

  return (
    <div className="flex h-[52px] items-center gap-3 border-b border-border-light bg-white px-5">
      <div className="flex-1 text-il-topbar text-text-2">{props.breadcrumb}</div>
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-[#c8dff7] bg-[#EBF4FF] px-2.5 py-0.5 text-il-pill font-medium text-accent-mid">
          {licenseTag}
        </span>
        <button className="rounded-[7px] border border-border bg-white px-3 py-1 text-il-pill text-text-2 hover:border-accent hover:text-accent">
          {t.common.help}
        </button>
      </div>
    </div>
  )
}

function ImportUploadPage(props: {
  handoff: ImportWizardHandoff | null
  onConsumeHandoff: () => void
  onNav: (k: NavKey) => void
}) {
  const [queue, setQueue] = useState<PickedExcel[]>([])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const [batchDate, setBatchDate] = useState(() => yyyymmddTodayLocal())
  const [sheetKeyOptions, setSheetKeyOptions] = useState<string[]>(() => [...sheetMappingOptionsFallback])
  const [targetSheetKeys, setTargetSheetKeys] = useState<string[]>(() => [...sheetMappingOptionsFallback])
  const [failPolicy, setFailPolicy] = useState<'stop' | 'skip'>('skip')
  const [forceReimport, setForceReimport] = useState(false)
  const [importing, setImporting] = useState(false)
  const [paused, setPaused] = useState(false)
  const [importEvents, setImportEvents] = useState<ImportEvent[]>([])
  const [failures, setFailures] = useState<ImportFailureRecord[]>([])
  const [importResult, setImportResult] = useState<ImportRunSnapshot | null>(null)
  const [importRunError, setImportRunError] = useState<string | null>(null)
  const [importPhase, setImportPhase] = useState<
    null | { kind: 'upload'; cur: number; total: number } | { kind: 'processing' }
  >(null)
  const [formatCheckStatus, setFormatCheckStatus] = useState<'idle' | 'checking' | 'passed' | 'failed'>('idle')
  const [formatCheckHint, setFormatCheckHint] = useState('')
  const [formatCheckBrowserIssues, setFormatCheckBrowserIssues] = useState<string[]>([])
  const [formatCheckYamlIssues, setFormatCheckYamlIssues] = useState<string[]>([])
  const [fieldMappingConfig, setFieldMappingConfig] = useState<FieldMappingConfig>(() => FALLBACK_FIELD_MAPPING_CONFIG)
  const [mappingTemplates, setMappingTemplates] = useState<
    { template_id: string; name: string; is_active?: boolean }[]
  >([])
  const [activeTemplateId, setActiveTemplateId] = useState('')
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [maxUploadMb, setMaxUploadMb] = useState(readStoredMaxUploadMb)
  const [autoImportAfterFormat, setAutoImportAfterFormat] = useState(readStoredAutoImportAfterFormat)
  const [autoDwdAfterImport, setAutoDwdAfterImport] = useState(readStoredAutoDwdAfterImport)
  const [rebuildRelAfterDwd, setRebuildRelAfterDwd] = useState(readStoredRebuildRelAfterDwd)
  const [serverMaxUploadMb, setServerMaxUploadMb] = useState<number | null>(null)
  const pausedRef = useRef(paused)
  const importingRef = useRef(importing)
  const logEndRef = useRef<HTMLDivElement | null>(null)
  const mappingAbortRef = useRef<AbortController | null>(null)
  const stopRef = useRef(false)
  /** 从格式检测页带入队列时，跳过一次「队列/目标变更 → 清空格式状态」避免把已通过状态清掉 */
  const skipNextFormatResetRef = useRef(0)
  /**
   * 非 null：当前「格式检测已通过」所允许的 Sheet key 上限（上传页仅可在此集合内缩小勾选，不可扩大）。
   * 由「格式检测页 handoff」或本页格式检测通过时写入；队列增删后清空。
   */
  const [formatValidatedSheetScope, setFormatValidatedSheetScope] = useState<string[] | null>(null)
  /** 最近一次格式检测通过时，目标 Sheet 勾选的签名（与 targetSig 同算法）；用于禁止「检测通过后再改勾选仍点导入」 */
  const [formatPassTargetSig, setFormatPassTargetSig] = useState<string | null>(null)
  /** 仅用于“本页格式检测通过后自动触发导入”的时序信号（避免 StrictMode/异步 setState 竞态） */
  const [formatPassToken, setFormatPassToken] = useState(0)
  const formatValidatedSheetScopeRef = useRef<string[] | null>(null)

  useEffect(() => {
    formatValidatedSheetScopeRef.current = formatValidatedSheetScope
  }, [formatValidatedSheetScope])

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  useEffect(() => {
    importingRef.current = importing
  }, [importing])

  const effectiveCeiling = useMemo(
    () =>
      serverMaxUploadMb != null && Number.isFinite(serverMaxUploadMb) && serverMaxUploadMb >= 1
        ? Math.floor(serverMaxUploadMb)
        : MAX_IMPORT_FILE_MB,
    [serverMaxUploadMb],
  )

  const persistMaxUploadMb = useCallback(
    (raw: number) => {
      const v = Math.max(1, Math.min(effectiveCeiling, Math.floor(Number(raw))))
      setMaxUploadMb(v)
      try {
        localStorage.setItem(LS_MAX_UPLOAD_MB, String(v))
      } catch {
        /* ignore */
      }
    },
    [effectiveCeiling],
  )

  const persistAutoDwdAfterImport = useCallback((v: boolean) => {
    setAutoDwdAfterImport(v)
    try {
      localStorage.setItem(LS_AUTO_DWD_AFTER_IMPORT, v ? '1' : '0')
    } catch {
      /* ignore */
    }
    if (!v) {
      setRebuildRelAfterDwd(false)
      try {
        localStorage.setItem(LS_REBUILD_REL_AFTER_DWD, '0')
      } catch {
        /* ignore */
      }
    }
  }, [])

  const persistRebuildRelAfterDwd = useCallback((v: boolean) => {
    setRebuildRelAfterDwd(v)
    try {
      localStorage.setItem(LS_REBUILD_REL_AFTER_DWD, v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [])

  const persistAutoImportAfterFormat = useCallback((v: boolean) => {
    setAutoImportAfterFormat(v)
    try {
      localStorage.setItem(LS_AUTO_IMPORT_AFTER_FORMAT, v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      const r = await fetchImportLimits(ac.signal)
      if (ac.signal.aborted || !r.ok) return
      setServerMaxUploadMb(r.max_upload_mb)
      setMaxUploadMb((prev) => {
        const cap = r.max_upload_mb
        const v = Math.max(1, Math.min(cap, prev))
        if (v !== prev) {
          try {
            localStorage.setItem(LS_MAX_UPLOAD_MB, String(v))
          } catch {
            /* ignore */
          }
        }
        return v
      })
    })()
    return () => ac.abort()
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    void fetchFieldMappingTemplates(ac.signal).then((res) => {
      if (ac.signal.aborted || !res.ok) return
      const templates = res.templates ?? []
      setMappingTemplates(templates)
      const active = String(res.active_template_id ?? '').trim()
      setActiveTemplateId(active)
      setSelectedTemplateId((prev) => {
        if (prev && templates.some((tpl) => tpl.template_id === prev)) return prev
        return active
      })
    })
    return () => ac.abort()
  }, [])

  const loadSheetMappingOnce = async (source: 'startup' | 'manual') => {
    mappingAbortRef.current?.abort()
    const ac = new AbortController()
    mappingAbortRef.current = ac
    try {
      const opts = await fetchSheetMappingOptions(ac.signal)
      const keys: string[] = []
      const seen = new Set<string>()
      for (const o of opts) {
        const k = String(o.sheet_key ?? '').trim()
        if (!k || seen.has(k)) continue
        seen.add(k)
        keys.push(k)
      }
      if (keys.length > 0) {
        // 强制按 config/sheet_mapping.yaml 书写顺序展示：优先使用本地兜底顺序作为“索引基准”。
        // （避免本地 API 返回顺序不一致导致 UI 顺序漂移；同时保证“不要调整顺序”的体验。）
        const keySet = new Set(keys)
        const ordered: string[] = [
          ...sheetMappingOptionsFallback.filter((k) => keySet.has(k as string)),
          ...keys.filter((k) => !sheetMappingOptionsFallback.includes(k as any)),
        ] as string[]

        setSheetKeyOptions(ordered)
        setTargetSheetKeys((prev) => {
          // 启动时默认全选，减少漏选导致的二次导入/补导成本。
          const defaultPick = [...ordered]
          if (source === 'startup') return defaultPick

          // 手动刷新：尽量保留已有选择（过滤掉已不存在的 key）
          const kept = prev.filter((k) => ordered.includes(k))
          if (kept.length > 0) return kept

          const scopeNow = formatValidatedSheetScopeRef.current
          if (scopeNow?.length) {
            const allow = new Set(scopeNow)
            const inScope = ordered.filter((k) => allow.has(k))
            if (inScope.length > 0) return inScope.slice(0, Math.min(3, inScope.length))
            return []
          }
          return defaultPick
        })
      }
    } catch {
      // 本地 API 不可用时静默回退到 fallback
      setSheetKeyOptions([...sheetMappingOptionsFallback])
      setTargetSheetKeys((prev) => {
        if (prev.length > 0) return prev
        const scopeNow = formatValidatedSheetScopeRef.current
        if (scopeNow?.length) {
          const allow = new Set(scopeNow)
          const inScope = sheetMappingOptionsFallback.filter((k) => allow.has(k))
          if (inScope.length > 0) return inScope.slice(0, Math.min(3, inScope.length))
        }
        return [...sheetMappingOptionsFallback]
      })
    }
  }

  useEffect(() => {
    void loadSheetMappingOnce('startup')
    return () => mappingAbortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      const fm = await fetchFieldMapping(ac.signal)
      if (ac.signal.aborted) return
      if (fm) setFieldMappingConfig(fm)
    })()
    return () => ac.abort()
  }, [])

  useEffect(() => {
    if (!importing) return
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [importEvents, importing])

  useEffect(() => {
    const valid = new Set(queue.map(queueRowKey))
    setSelectedKeys((prev) => {
      const next = new Set([...prev].filter((k) => valid.has(k)))
      return next.size === prev.size ? prev : next
    })
  }, [queue])

  const queueSig = useMemo(() => queue.map(queueRowKey).join('\u0001'), [queue])
  const targetSig = useMemo(
    () => [...targetSheetKeys].sort((a, b) => a.localeCompare(b, 'zh-CN')).join('|'),
    [targetSheetKeys],
  )

  const formatValidatedSheetScopeSet = useMemo(
    () => (formatValidatedSheetScope ? new Set(formatValidatedSheetScope) : null),
    [formatValidatedSheetScope],
  )

  useEffect(() => {
    if (!formatValidatedSheetScope) return
    const allow = new Set(formatValidatedSheetScope)
    setTargetSheetKeys((prev) => {
      const next = prev.filter((k) => allow.has(k))
      return next.length === prev.length ? prev : next
    })
  }, [formatValidatedSheetScope, sheetKeyOptions])

  useEffect(() => {
    if (skipNextFormatResetRef.current > 0) {
      skipNextFormatResetRef.current -= 1
      return
    }
    setFormatCheckStatus('idle')
    setFormatCheckHint('')
    setFormatCheckBrowserIssues([])
    setFormatCheckYamlIssues([])
    setFormatPassTargetSig(null)
  }, [queueSig, targetSig, maxUploadMb, fieldMappingConfig])

  useEffect(() => {
    const h = props.handoff
    if (!h) return
    const cap =
      serverMaxUploadMb != null && Number.isFinite(serverMaxUploadMb) && serverMaxUploadMb >= 1
        ? Math.floor(serverMaxUploadMb)
        : MAX_IMPORT_FILE_MB
    const mb = Math.max(1, Math.min(cap, Math.floor(Number(h.maxUploadMb)) || 1))
    skipNextFormatResetRef.current = 1
    setQueue(h.queue)
    const normalizedTargets = normalizeValidatedSheetScope(h.targetSheetKeys)
    setTargetSheetKeys(normalizedTargets)
    setMaxUploadMb(mb)
    try {
      localStorage.setItem(LS_MAX_UPLOAD_MB, String(mb))
    } catch {
      /* ignore */
    }
    setFormatCheckStatus('passed')
    setFormatCheckHint(t.importUpload.formatPassedFromHandoff)
    setFormatCheckBrowserIssues([])
    setFormatCheckYamlIssues([])
    setFormatValidatedSheetScope(normalizedTargets)
    setFormatPassTargetSig(sheetKeysSignature(normalizedTargets))
    props.onConsumeHandoff()
  }, [props.handoff, serverMaxUploadMb, props.onConsumeHandoff])

  const addFiles = (items: PickedExcel[]) => {
    if (importingRef.current) return
    const incoming = filterOutOfficeLockFiles(items)
    if (incoming.length === 0) return
    setFormatValidatedSheetScope(null)
    setQueue((prev) => {
      const seen = new Set(
        prev.map((p) => `${p.pathLabel ?? ''}|${p.file.name}:${p.file.size}:${p.file.lastModified}`),
      )
      const next = [...prev]
      for (const { file: f, pathLabel } of incoming) {
        const k = `${pathLabel ?? ''}|${f.name}:${f.size}:${f.lastModified}`
        if (!seen.has(k)) {
          seen.add(k)
          next.push({ file: f, pathLabel })
        }
      }
      return next
    })
  }

  const queueTitle =
    queue.length > 0 ? `${t.importUpload.queue}（${queue.length}）` : t.importUpload.queue
  const queueDense = queue.length > 40
  const selectedCount = selectedKeys.size
  const allSelected = queue.length > 0 && queue.every((r) => selectedKeys.has(queueRowKey(r)))

  const toggleRow = (key: string) => {
    if (importingRef.current) return
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (importingRef.current) return
    if (queue.length === 0) return
    if (allSelected) setSelectedKeys(new Set())
    else setSelectedKeys(new Set(queue.map(queueRowKey)))
  }

  const removeRowsByKeys = (keys: Set<string>) => {
    if (importingRef.current) return
    if (keys.size === 0) return
    setFormatValidatedSheetScope(null)
    setQueue((prev) => prev.filter((r) => !keys.has(queueRowKey(r))))
  }

  const removeSelectedFromQueue = () => removeRowsByKeys(selectedKeys)

  const runFormatCheck = async () => {
    if (importingRef.current || queue.length === 0) return
    setFormatCheckStatus('checking')
    setFormatCheckHint(formatCheckProgressHint(0, queue.length))
    await new Promise<void>((r) => setTimeout(r, 280))

    const { browserIssues, yamlIssues } = await validateImportQueueFormat({
      queue,
      targetSheetKeys,
      fieldMappingConfig,
      maxUploadMb,
      onProgress: (done, total) => setFormatCheckHint(formatCheckProgressHint(done, total)),
    })

    const total = browserIssues.length + yamlIssues.length
    if (total > 0) {
      setFormatCheckStatus('failed')
      setFormatCheckBrowserIssues(browserIssues)
      setFormatCheckYamlIssues(yamlIssues)
      setFormatPassTargetSig(null)
      const parts: string[] = []
      if (browserIssues.length > 0) parts.push(`${browserIssues.length} 项结构/标准字段`)
      if (yamlIssues.length > 0) parts.push(`${yamlIssues.length} 项 YAML 未覆盖表头`)
      setFormatCheckHint(`${t.importUpload.formatFailed}（${parts.join('，')}，见下方分块）`)
      return
    }
    const normalizedPass = normalizeValidatedSheetScope(targetSheetKeys)
    skipNextFormatResetRef.current = 1
    setTargetSheetKeys(normalizedPass)
    setFormatCheckBrowserIssues([])
    setFormatCheckYamlIssues([])
    setFormatCheckStatus('passed')
    setFormatCheckHint(t.importUpload.formatPassed)
    setFormatValidatedSheetScope(normalizedPass)
    setFormatPassTargetSig(sheetKeysSignature(normalizedPass))
    setFormatPassToken(Date.now())
  }

  useEffect(() => {
    if (!autoImportAfterFormat) return
    if (formatPassToken <= 0) return
    if (importingRef.current) return
    if (queue.length === 0) return
    if (formatCheckStatus !== 'passed') return
    if (startImportBlockedByTargetSheetDrift) return
    if (forceReimport) {
      const ok = window.confirm(
        '已开启“强制重导（忽略判重）”。继续后可能写入重复数据，仅建议用于扩范围补导或修复场景。是否继续导入？',
      )
      if (!ok) return
    }
    void startImport()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatPassToken, autoImportAfterFormat])

  const startImportBlockedByTargetSheetDrift = useMemo(() => {
    if (formatCheckStatus !== 'passed') return false
    if (formatPassTargetSig == null) return true
    if (targetSig !== formatPassTargetSig) return true
    if (formatValidatedSheetScopeSet) {
      for (const k of targetSheetKeys) {
        if (!formatValidatedSheetScopeSet.has(k)) return true
      }
    }
    return false
  }, [
    formatCheckStatus,
    formatPassTargetSig,
    targetSig,
    targetSheetKeys,
    formatValidatedSheetScopeSet,
  ])

  const startImport = async () => {
    if (importingRef.current) return
    if (queue.length === 0) return
    if (formatCheckStatus !== 'passed') return
    if (startImportBlockedByTargetSheetDrift) return

    const allowSimOnApiFailure =
      Boolean(import.meta.env.DEV) || import.meta.env.VITE_IMPORT_SIM_ON_FAIL === 'true'

    const target = [...queue]
    const policy = failPolicy
    const sheets = [...targetSheetKeys]
    const batch = batchDate
    const capMb = maxUploadMb

    const collectedEvs: ImportEvent[] = []
    const collectedFails: ImportFailureRecord[] = []
    let resetFormatAfterRun = false

    const pushFailureFromFileResult = (ev: ImportEvent) => {
      if (ev.type !== 'file_result' || ev.payload.result !== 'failed') return
      const action: ImportFailureRecord['action_taken'] =
        policy === 'stop' ? 'stop_session' : 'skip_excel'
      const rec: ImportFailureRecord = {
        file_key: ev.payload.file_key,
        file_name: ev.payload.file_name,
        reason: ev.payload.reason || '失败',
        action_taken: action,
      }
      if (ev.payload.exception_type) rec.exception_type = ev.payload.exception_type
      collectedFails.push(rec)
      setFailures((prev) => [...prev, rec].slice(-300))
    }

    const finalizeSnapshot = (source: 'api' | 'sim', simDueToApiFailure?: boolean) => {
      let end: ImportEvent | undefined
      for (let i = collectedEvs.length - 1; i >= 0; i--) {
        if (collectedEvs[i].type === 'session_end') {
          end = collectedEvs[i]
          break
        }
      }
      if (!end || end.type !== 'session_end') return false
      resetFormatAfterRun = true
      const sessionMeta = extractImportSessionMeta(collectedEvs)
      setImportResult({
        source,
        simDueToApiFailure: simDueToApiFailure === true,
        batchDate: batch,
        success: end.payload.success_files,
        failed: end.payload.failed_files,
        skipped: end.payload.skipped_files,
        events: collectedEvs,
        failures: collectedFails,
        runQueue: target,
        importSessionId: sessionMeta.importSessionId,
        fieldMappingTemplate: sessionMeta.fieldMappingTemplate,
      })
      return true
    }

    setImporting(true)
    setPaused(false)
    setImportEvents([])
    setFailures([])
    setImportResult(null)
    setImportRunError(null)
    setImportPhase({ kind: 'upload', cur: 0, total: target.length })
    stopRef.current = false

    try {
      try {
        const sid = await createImportSessionUpload({
          batchDate: batch,
          failPolicy: policy,
          forceReimport,
          targetSheetKeys: sheets,
          maxUploadMb: capMb,
          autoDwdAfterImport,
          rebuildEnterpriseYearRelAfterDwd: rebuildRelAfterDwd,
          fieldMappingTemplateId: selectedTemplateId || undefined,
          files: target.map((r) => ({ file: r.file, pathLabel: r.pathLabel })),
          onUploadProgress: (done, total) => {
            setImportPhase({ kind: 'upload', cur: done, total })
          },
        })
        setImportPhase({ kind: 'processing' })
        let after = 0
        let streamBroken = false
        for (;;) {
          if (stopRef.current) break
          const pack = await fetchImportSessionEvents(sid, after)
          if (!pack.ok) {
            streamBroken = true
            setImportRunError(pack.error?.message ?? t.importUpload.importEventsStreamError)
            break
          }
          after = pack.next_after_event_id
          for (const e of pack.events) {
            const ev = apiEventToImportEvent(e)
            collectedEvs.push(ev)
            setImportEvents((prev) => [...prev, ev].slice(-2000))
            pushFailureFromFileResult(ev)
          }
          if (pack.finished) break
          await new Promise((r) => setTimeout(r, 280))
        }
        if (!stopRef.current && !streamBroken) {
          const ok = finalizeSnapshot('api')
          if (!ok) setImportRunError(t.importUpload.importNoSessionEnd)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (allowSimOnApiFailure) {
          setImportRunError(null)
          setImportPhase({ kind: 'processing' })
          const import_session_id = `sim_${Math.random().toString(16).slice(2)}`
          await runSimulatedImport({
            import_session_id,
            batch_date: batch,
            queue: target,
            target_sheet_keys: sheets,
            fail_policy: policy,
            is_paused: () => pausedRef.current,
            should_stop: () => stopRef.current || !importingRef.current,
            on_event: (ev) => {
              collectedEvs.push(ev)
              setImportEvents((prev) => [...prev, ev].slice(-2000))
            },
            on_failure: (rec) => {
              collectedFails.push(rec)
              setFailures((prev) => [...prev, rec].slice(-300))
            },
          })
          finalizeSnapshot('sim', true)
        } else {
          setImportRunError(msg)
        }
      }
    } finally {
      setImporting(false)
      setImportPhase(null)
      if (resetFormatAfterRun) {
        setFormatCheckStatus('idle')
        setFormatCheckHint('')
        setFormatCheckBrowserIssues([])
        setFormatCheckYamlIssues([])
      }
    }
  }

  const togglePause = () => {
    if (!importingRef.current) return
    setPaused((p) => !p)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-[22px]">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-2 pr-0.5 [-webkit-overflow-scrolling:touch]">
      <div className="mb-5 shrink-0">
        <div className="mb-1 text-il-page-title font-semibold text-text">{t.importUpload.title}</div>
        <div className="text-il-page-desc text-text-2">
          {t.importUpload.description}
        </div>
      </div>

      <div className={['mb-4 shrink-0', importing ? 'pointer-events-none opacity-60' : ''].join(' ')}>
        <UploadZone onFiles={addFiles} />
      </div>

      <Card title={t.importUpload.templateSectionTitle} className="mb-4 shrink-0">
        <p className="mb-2 text-il-meta text-text-2">{t.importUpload.templateSectionHint}</p>
        <label className="mb-1 block text-il-label font-medium text-text-2">
          {t.importUpload.templateSelectLabel}
        </label>
        <select
          value={selectedTemplateId}
          onChange={(e) => setSelectedTemplateId(e.target.value)}
          className="h-[33px] w-full max-w-md rounded-[7px] border border-border bg-[#fafbfc] px-2 py-[7px] text-il-input text-text outline-none focus:border-accent focus:bg-white"
          disabled={importing || mappingTemplates.length === 0}
        >
          {mappingTemplates.length === 0 ? (
            <option value="">{t.importUpload.templateUseActive}</option>
          ) : (
            mappingTemplates.map((tpl) => (
              <option key={tpl.template_id} value={tpl.template_id}>
                {tpl.name}
                {tpl.template_id === activeTemplateId ? ` · ${t.importUpload.templateActiveBadge}` : ''}
              </option>
            ))
          )}
        </select>
      </Card>

      <Card title={t.importUpload.batchConfig} className="mb-4 shrink-0">
        <div className="mb-2 flex min-w-0 flex-nowrap items-start gap-2 sm:gap-3">
          <div className="w-[118px] shrink-0 sm:w-[128px]">
            <label className="mb-1 block text-il-label font-medium leading-tight text-text-2">
              {t.importUpload.labelBatchDate}
            </label>
            <input
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              placeholder={t.importUpload.batchDatePlaceholder}
              title={t.importUpload.batchDateHint}
              className="h-[33px] w-full rounded-[7px] border border-border bg-[#fafbfc] px-2 py-[7px] font-mono text-[13px] text-il-input text-text placeholder:text-text-3 outline-none focus:border-accent focus:bg-white"
              value={batchDate}
              onChange={(e) => setBatchDate(e.target.value.replace(/\D/g, '').slice(0, 8))}
              disabled={importing}
            />
            <p className="mt-1 text-[11px] leading-snug text-text-3">{t.importUpload.batchDateHint}</p>
          </div>
          <div className="w-[92px] shrink-0 sm:w-[100px]">
            <label className="mb-1 block text-il-label font-medium leading-tight text-text-2">
              {t.importUpload.labelMaxFileMb}
            </label>
            <input
              type="number"
              min={1}
              max={effectiveCeiling}
              title={t.importUpload.hintMaxFileMb.replace(/\{mb\}/g, String(effectiveCeiling))}
              className="h-[33px] w-full rounded-[7px] border border-border bg-[#fafbfc] px-2 py-[7px] text-il-input text-text outline-none focus:border-accent focus:bg-white"
              value={maxUploadMb}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (!Number.isFinite(n)) return
                persistMaxUploadMb(n)
              }}
              disabled={importing}
            />
          </div>
          <div className="w-[104px] shrink-0 sm:w-[116px]">
            <label className="mb-1 block text-il-label font-medium leading-tight text-text-2">
              {t.importUpload.labelAutoImportAfterFormat}
            </label>
            <select
              value={autoImportAfterFormat ? 'auto' : 'manual'}
              onChange={(e) => persistAutoImportAfterFormat(e.target.value === 'auto')}
              className="h-[33px] w-full rounded-[7px] border border-border bg-[#fafbfc] px-2 py-[7px] text-il-input text-text outline-none focus:border-accent focus:bg-white"
              disabled={importing}
            >
              <option value="auto">{t.importUpload.optAutoTrigger}</option>
              <option value="manual">{t.importUpload.optManualTrigger}</option>
            </select>
          </div>
          <div className="w-[104px] shrink-0 sm:w-[116px]">
            <label
              className="mb-1 block text-il-label font-medium leading-tight text-text-2"
              title={t.importUpload.hintDwdAuto}
            >
              {t.importUpload.labelDwd}
            </label>
            <select
              value={autoDwdAfterImport ? 'auto' : 'manual'}
              onChange={(e) => persistAutoDwdAfterImport(e.target.value === 'auto')}
              className="h-[33px] w-full rounded-[7px] border border-border bg-[#fafbfc] px-2 py-[7px] text-il-input text-text outline-none focus:border-accent focus:bg-white"
              disabled={importing}
              title={t.importUpload.hintDwdAuto}
            >
              <option value="auto">{t.importUpload.optDwdAuto}</option>
              <option value="manual">{t.importUpload.optDwdManual}</option>
            </select>
          </div>
          <div className="w-[152px] shrink-0">
            <label
              className="mb-1 block text-il-label font-medium leading-tight text-text-2"
              title={t.importUpload.rebuildRelAfterDwdHint}
            >
              {t.importUpload.rebuildRelAfterDwdLabel}
            </label>
            <label
              className={[
                'flex h-[33px] cursor-pointer items-center gap-2 rounded-[7px] border border-border bg-[#fafbfc] px-2 text-il-input text-text-2',
                importing || !autoDwdAfterImport ? 'cursor-not-allowed opacity-60' : 'hover:border-accent',
              ].join(' ')}
              title={t.importUpload.rebuildRelAfterDwdHint}
            >
              <input
                type="checkbox"
                checked={rebuildRelAfterDwd}
                onChange={(e) => persistRebuildRelAfterDwd(e.target.checked)}
                disabled={importing || !autoDwdAfterImport}
                className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent"
              />
              <span className="truncate text-il-meta">启用</span>
            </label>
          </div>
          <div className="w-[152px] shrink-0">
            <label className="mb-1 block text-il-label font-medium leading-tight text-text-2">
              {t.importUpload.labelForceReimport}
            </label>
            <label
              className={[
                'flex h-[33px] cursor-pointer items-center gap-2 rounded-[7px] border border-border bg-[#fafbfc] px-2 text-il-input text-text-2',
                importing ? 'cursor-not-allowed opacity-60' : 'hover:border-accent',
              ].join(' ')}
              title={t.importUpload.hintForceReimport}
            >
              <input
                type="checkbox"
                checked={forceReimport}
                onChange={(e) => setForceReimport(e.target.checked)}
                disabled={importing}
                className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent"
              />
              <span className="truncate">{t.importUpload.forceReimportToggle}</span>
            </label>
          </div>
          <div className="min-w-0 w-[min(100%,14rem)] shrink-0">
            <label className="mb-1 block text-il-label font-medium leading-tight text-text-2">
              {t.importUpload.failPolicy}
            </label>
            <select
              value={failPolicy}
              onChange={(e) => setFailPolicy(e.target.value as 'stop' | 'skip')}
              className="h-[33px] w-full max-w-full rounded-[7px] border border-border bg-[#fafbfc] px-2 py-[7px] text-il-input text-text outline-none focus:border-accent focus:bg-white"
              disabled={importing}
            >
              <option value="stop">{t.importUpload.failStop}</option>
              <option value="skip">{t.importUpload.failSkip}</option>
            </select>
          </div>
        </div>
        <div className="mb-3 text-il-meta leading-snug text-text-3">
          {t.importUpload.hintMaxFileMb.replace(/\{mb\}/g, String(effectiveCeiling))}
        </div>
        {forceReimport ? (
          <div className="mb-3 rounded-md border border-[#f5d27a] bg-[#fff8e8] px-2.5 py-2 text-il-meta leading-snug text-[#8a6d00]">
            {t.importUpload.forceReimportWarn}
          </div>
        ) : null}

        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-[12px] font-normal text-text-2">
              {t.importUpload.targetSheets}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={importing}
                className={[
                  'rounded-[7px] bg-accent px-4 py-1.5 text-il-btn font-medium text-white hover:bg-accent-mid disabled:cursor-not-allowed disabled:opacity-60',
                  importing ? 'opacity-60' : '',
                ].join(' ')}
                onClick={() => {
                  if (formatValidatedSheetScopeSet) {
                    setTargetSheetKeys(
                      sheetKeyOptions.filter((key) => formatValidatedSheetScopeSet.has(key)),
                    )
                    return
                  }
                  setTargetSheetKeys([...sheetKeyOptions])
                }}
                title={
                  formatValidatedSheetScopeSet
                    ? t.importUpload.targetSheetsSelectAllWithinFormatScope
                    : undefined
                }
              >
                {t.importUpload.targetSheetsSelectAll}
              </button>
              <button
                type="button"
                disabled={importing}
                className={[
                  'rounded-[7px] border border-border bg-white px-2.5 py-1 text-il-btn text-text-2 hover:border-danger hover:text-danger',
                  importing ? 'opacity-60' : '',
                ].join(' ')}
                onClick={() => setTargetSheetKeys([])}
              >
                {t.importUpload.targetSheetsClearAll}
              </button>
              <button
                type="button"
                disabled={importing}
                className={[
                  'rounded-[7px] border px-2.5 py-1 text-il-btn text-text-2 hover:border-accent hover:text-accent',
                  importing ? 'opacity-60' : '',
                ].join(' ')}
                onClick={() => void loadSheetMappingOnce('manual')}
                title="从本地配置刷新映射"
              >
                {t.importUpload.targetSheetsRefresh}
              </button>
            </div>
          </div>

          <div className={TARGET_SHEET_AREA_SCROLL_CLASS}>
            {/* grid 行优先：与 sheet_mapping.yaml 中从上到下的书写顺序一致（左→右，再下一行） */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-4">
              {sheetKeyOptions.map((k) => {
                const checked = targetSheetKeys.includes(k)
                const lockedOut =
                  formatValidatedSheetScopeSet != null && !formatValidatedSheetScopeSet.has(k)
                return (
                  <label
                    key={k}
                    className={[
                      'mb-1 break-inside-avoid flex select-none items-center gap-2',
                      lockedOut || importing ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
                    ].join(' ')}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={importing || lockedOut}
                      title={lockedOut ? t.importUpload.targetSheetLockedNotInFormatScope : undefined}
                      onChange={() => {
                        if (lockedOut) return
                        setTargetSheetKeys((prev) => {
                          if (prev.includes(k)) return prev.filter((x) => x !== k)
                          return [...prev, k]
                        })
                      }}
                      className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent disabled:cursor-not-allowed"
                    />
                    <span
                      className="truncate text-[12px] text-text-2"
                      title={lockedOut ? t.importUpload.targetSheetLockedNotInFormatScope : k}
                    >
                      {k}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

          {formatValidatedSheetScope ? (
            <div className="mt-2 rounded-md border border-[#c8dff7] bg-[#f0f7ff] px-2.5 py-2 text-il-meta leading-snug text-accent-mid">
              {t.importUpload.targetSheetsScopeLockedHint}
            </div>
          ) : null}

          <div className="mt-2 text-il-meta leading-snug text-text-3">{t.importUpload.targetSheetsIngestHint}</div>
        </div>

      </Card>

      <Card
        title={queueTitle}
        className={
          queue.length === 0
            ? '!mb-0 shrink-0'
            : importing
              ? '!mb-3 shrink-0'
              : '!mb-0 flex min-h-0 flex-1 flex-col overflow-hidden'
        }
        bodyClassName={
          queue.length === 0
            ? undefined
            : importing
              ? 'max-h-[200px] overflow-y-auto pr-0.5'
              : 'min-h-[min(280px,42vh)] flex-1 overflow-y-auto pr-0.5'
        }
      >
        {queue.length === 0 ? (
          <div className="text-il-page-desc text-text-3">{t.importUpload.queueEmpty}</div>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border-light pb-2">
              <label className="flex cursor-pointer select-none items-center gap-2 text-il-meta text-text-2">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  disabled={importing}
                />
                {t.importUpload.queueSelectAll}
              </label>
              <button
                type="button"
                disabled={selectedCount === 0 || importing}
                className={[
                  'rounded-[6px] px-2.5 py-1 text-il-meta font-medium transition-colors',
                  selectedCount === 0
                    ? 'cursor-not-allowed text-text-3'
                    : 'text-danger hover:bg-[#fff5f5]',
                ].join(' ')}
                onClick={removeSelectedFromQueue}
              >
                {t.importUpload.queueRemoveSelected}
                {selectedCount > 0 ? `（${selectedCount}）` : ''}
              </button>
            </div>
            <ul>
              {queue.map((row, idx) => {
                const f = row.file
                const pathText = row.pathLabel?.trim()
                const key = queueRowKey(row)
                const rowSelected = selectedKeys.has(key)
                return (
                  <li
                    key={key}
                    className={[
                      'flex gap-2 border-b border-border-light last:border-b-0',
                      queueDense ? 'py-1.5' : 'py-2.5',
                    ].join(' ')}
                  >
                    <div className="flex flex-shrink-0 items-start pt-0.5">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent"
                        checked={rowSelected}
                        onChange={() => toggleRow(key)}
                        aria-label={`${f.name}`}
                        disabled={importing}
                      />
                    </div>
                    <div
                      className={[
                        'flex flex-shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-white',
                        queueDense ? 'h-[20px] min-w-[20px] px-1 text-[10px]' : 'h-[23px] w-[23px] text-il-meta',
                      ].join(' ')}
                    >
                      {idx + 1}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div
                        className={[
                          'truncate font-medium text-text',
                          queueDense ? 'text-[11px]' : 'text-[12px]',
                        ].join(' ')}
                      >
                        {f.name}
                      </div>
                      <div
                        className={[
                          'mt-0.5 text-text-3',
                          queueDense ? 'text-[10px]' : 'text-il-meta',
                        ].join(' ')}
                      >
                        {t.importUpload.pendingImport} · {Math.round(f.size / 1024)} KB
                      </div>
                    </div>
                    <div
                      className={[
                        'min-w-0 flex-1 text-right',
                        queueDense ? 'text-[10px]' : 'text-[11px]',
                      ].join(' ')}
                      title={pathText ? undefined : t.importUpload.pathNotProvidedHint}
                    >
                      {pathText ? (
                        <span className="break-all text-text-2">{pathText}</span>
                      ) : (
                        <span className="text-text-3">{t.importUpload.pathPlaceholder}</span>
                      )}
                    </div>
                    <div className="flex flex-shrink-0 items-start pt-0">
                      <button
                        type="button"
                        title={t.importUpload.queueRemoveRowTitle}
                        className="rounded px-1.5 py-0.5 text-il-meta text-text-3 hover:bg-[#fff5f5] hover:text-danger"
                        onClick={() => removeRowsByKeys(new Set([key]))}
                        disabled={importing}
                      >
                        {t.importUpload.queueRemoveRow}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </Card>

      {importing ? (
        <div className="mb-4 grid min-h-[min(52vh,520px)] min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card
            title={t.importUpload.importProgress}
            className="flex min-h-0 min-w-0 flex-col overflow-hidden"
            bodyClassName="min-h-[min(44vh,420px)] max-h-[min(62vh,640px)] min-w-0 max-w-full flex-1 overflow-y-auto overflow-x-hidden pr-0.5 [overflow-wrap:anywhere]"
          >
            <div className="min-w-0 space-y-1">
              {importPhase && importEvents.length === 0 ? (
                <div className="mb-2 text-il-meta leading-snug text-accent-mid">
                  {importPhase.kind === 'upload'
                    ? t.importUpload.importPhaseUpload
                        .replace('{cur}', String(importPhase.cur))
                        .replace('{total}', String(importPhase.total))
                    : t.importUpload.importPhaseProcessing}
                </div>
              ) : null}
              {importEvents.length === 0 && !importPhase ? (
                <div className="text-il-page-desc text-text-3">{t.importUpload.importingNow}</div>
              ) : null}
              {importEvents.length > 0 ? (
                importEvents.map((ev) => (
                  <div key={ev.event_id} className="min-w-0 break-all text-[12px] text-text-3">
                    <span className="text-text-3">[{ev.type}] </span>
                    <span className="text-text-2">
                      {ev.type === 'file_start'
                        ? `开始：${ev.payload.file_name}（${ev.payload.file_index}/${ev.payload.total_files}）`
                        : ev.type === 'sheet_stage'
                          ? `${ev.payload.file_name} · ${ev.payload.sheet} · ${ev.payload.stage} · ${ev.payload.state}${
                              ev.payload.message ? ` · ${ev.payload.message}` : ''
                            }`
                          : ev.type === 'file_result'
                            ? `${ev.payload.file_name} · 结果=${ev.payload.result}${
                                ev.payload.file_index != null
                                  ? ` · #${ev.payload.file_index}/${ev.payload.total_files ?? '—'}`
                                  : ''
                              }${
                                ev.payload.rollback_sheets?.length
                                  ? ` · 回滚=${ev.payload.rollback_sheets.join('、')}`
                                  : ''
                              }`
                            : ev.type === 'session_start'
                              ? `会话开始：批次=${ev.payload.batch_date} · 文件数=${ev.payload.total_files}`
                              : ev.type === 'session_end'
                                ? `会话结束：成功=${ev.payload.success_files} · 失败=${ev.payload.failed_files} · 跳过=${ev.payload.skipped_files}`
                                : ev.type === 'post_dwd_begin'
                                  ? t.importUpload.importEventPostDwdBegin
                                  : ev.type === 'post_dwd_end'
                                    ? ev.payload.ok
                                      ? `${t.importUpload.importEventPostDwdEndOk} · 年度=${(ev.payload.stat_years_built ?? []).join('、') || '—'}`
                                      : `${t.importUpload.importEventPostDwdEndFail} · ${ev.payload.error?.message ?? ''}`
                                    : ''}
                    </span>
                  </div>
                ))
              ) : null}
              <div ref={logEndRef} />
            </div>
          </Card>

          <Card
            title={t.importUpload.importFailures}
            className="flex min-h-0 min-w-0 flex-col overflow-hidden"
            bodyClassName="min-h-[min(44vh,420px)] max-h-[min(62vh,640px)] min-w-0 max-w-full flex-1 overflow-y-auto overflow-x-hidden pr-0.5 [overflow-wrap:anywhere]"
          >
            {failures.length === 0 ? (
              <div className="text-il-page-desc text-text-3">{t.importUpload.importFailuresEmpty}</div>
            ) : (
              <div className="min-w-0 space-y-2">
                {failures.map((f, idx) => (
                  <div
                    key={`${idx}-${f.file_key}`}
                    className="min-w-0 rounded border border-border-light bg-white px-2.5 py-2"
                  >
                    <div className="min-w-0 break-all text-[12px] font-medium text-text" title={f.file_name}>
                      {f.file_name}
                    </div>
                    <div className="mt-0.5 min-w-0 break-all text-[11px] text-text-2">
                      {f.sheet ? `Sheet：${f.sheet}` : 'Sheet：—'} · {f.stage ? `阶段：${f.stage}` : '阶段：—'}
                    </div>
                    <div className="mt-0.5 break-all text-[11px] text-danger">
                      {f.reason}
                      {f.exception_type ? `（${f.exception_type}）` : ''}
                    </div>
                    <div className="mt-0.5 text-[11px] text-text-3">
                      处理：
                      {f.action_taken === 'stop_session'
                        ? t.importUpload.failureActionStop
                        : t.importUpload.failureActionSkip}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {importResult && !importing ? (
        <Card title={t.importUpload.resultTitle} className="mb-4 shrink-0">
          <div
            className={[
              'mb-3 rounded-md border px-2.5 py-2 text-il-meta leading-snug',
              importResult.source === 'api' && importResult.simDueToApiFailure !== true
                ? 'border-[#b7e4c8] bg-[#f0fdf4] text-[#0d5c2e]'
                : 'border-[#fde68a] bg-[#fffbeb] text-[#92400e]',
            ].join(' ')}
          >
            {importResult.source === 'api' && importResult.simDueToApiFailure !== true
              ? t.importUpload.resultSourceBadgeApi
              : importResult.simDueToApiFailure === true
                ? t.importUpload.resultSourceBadgeSimFallback
                : t.importUpload.resultSourceBadgeSim}
          </div>
          <div className="mb-3 text-il-page-desc text-text-3">{t.importUpload.resultHint}</div>
          <div className="mb-4 flex flex-wrap gap-6 text-[13px] text-text-2">
            <div>
              <span className="text-text-3">{t.importUpload.resultSuccess}：</span>
              <span className="font-semibold text-text">{importResult.success}</span>
            </div>
            <div>
              <span className="text-text-3">{t.importUpload.resultFailed}：</span>
              <span className="font-semibold text-danger">{importResult.failed}</span>
            </div>
            <div>
              <span className="text-text-3">{t.importUpload.resultSkipped}：</span>
              <span className="font-semibold text-text-2">{importResult.skipped}</span>
            </div>
            <div>
              <span className="text-text-3">拒收行样本：</span>
              <span className="font-semibold text-text">
                {collectRejectRowsForExport(importResult.events).length}
              </span>
            </div>
            {importResult.fieldMappingTemplate ? (
              <div className="min-w-[12rem]">
                <span className="text-text-3">{t.importUpload.resultTemplateLabel}：</span>
                <span className="font-semibold text-text">
                  {importResult.fieldMappingTemplate.template_name}
                </span>
                <span className="ml-1 font-mono text-[11px] text-text-3">
                  ({importResult.fieldMappingTemplate.template_id})
                </span>
              </div>
            ) : null}
            {importResult.importSessionId ? (
              <div className="min-w-[10rem]">
                <span className="text-text-3">{t.importUpload.resultSessionLabel}：</span>
                <span className="font-mono text-[12px] text-text">{importResult.importSessionId}</span>
              </div>
            ) : null}
          </div>
          {collectRejectRowsForExport(importResult.events).length === 0 ? (
            <div className="mb-3 text-il-meta text-text-3">{t.importUpload.resultCsvEmpty}</div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
              onClick={() => downloadJson(importResult)}
            >
              {t.importUpload.resultDownloadJson}
            </button>
            <button
              type="button"
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
              onClick={() => downloadRejectRowsCsv(importResult)}
            >
              {t.importUpload.resultDownloadCsv}
            </button>
            {importResult.importSessionId &&
            importResult.source === 'api' &&
            importResult.simDueToApiFailure !== true ? (
              <button
                type="button"
                className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
                onClick={() =>
                  navigateToQualityPage(props.onNav, 'import_quality_detail', {
                    batchId: importResult.batchDate,
                    sessionId: importResult.importSessionId,
                    domain: 'lineage_reject',
                  })
                }
              >
                {t.importUpload.resultOpenQualityLineage}
              </button>
            ) : null}
            <button
              type="button"
              disabled={getFailedQueueRows(importResult).length === 0}
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => {
                const rows = getFailedQueueRows(importResult)
                if (rows.length === 0) return
                setFormatValidatedSheetScope(null)
                setQueue(rows)
                setSelectedKeys(new Set(rows.map(queueRowKey)))
                setImportResult(null)
              }}
            >
              {t.importUpload.resultRetryFailed}
            </button>
            <button
              type="button"
              className="rounded-[7px] border border-border bg-white px-3 py-1.5 text-il-btn text-text-3 hover:border-danger hover:text-danger"
              onClick={() => setImportResult(null)}
            >
              {t.importUpload.resultDismiss}
            </button>
          </div>
        </Card>
      ) : null}

      {queue.length > 0 && !importing ? (
        <div
          className={[
            'mb-2 shrink-0 text-il-page-desc',
            formatCheckStatus === 'passed'
              ? 'text-[#0d7a3e]'
              : formatCheckStatus === 'failed'
                ? 'text-danger'
                : 'text-text-3',
          ].join(' ')}
        >
          {formatCheckStatus === 'idle' && !formatCheckHint
            ? t.importUpload.formatIdleHint
            : formatCheckHint}
        </div>
      ) : null}

      {queue.length > 0 &&
      !importing &&
      formatCheckStatus === 'failed' &&
      (formatCheckBrowserIssues.length > 0 || formatCheckYamlIssues.length > 0) ? (
        <FormatCheckIssueBlocks
          browserIssues={formatCheckBrowserIssues}
          yamlIssues={formatCheckYamlIssues}
        />
      ) : null}

      {importRunError && !importing ? (
        <div className="mb-3 shrink-0 rounded-md border border-danger/35 bg-[#fff5f5] px-3 py-2 text-il-meta text-danger">
          <div className="font-medium text-text">{t.importUpload.importRunErrorTitle}</div>
          <div className="mt-1 break-all text-text-2">{importRunError}</div>
        </div>
      ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap gap-2 border-t border-border-light bg-bg pt-3 pb-0">
        <button
          type="button"
          className={[
            'rounded-[7px] border border-accent bg-white px-4 py-1.5 text-il-btn font-medium text-accent hover:bg-[#f0f7ff] disabled:cursor-not-allowed disabled:opacity-60',
          ].join(' ')}
          disabled={queue.length === 0 || importing || formatCheckStatus === 'checking'}
          onClick={() => void runFormatCheck()}
        >
          {formatCheckStatus === 'checking' ? t.importUpload.formatChecking : t.importUpload.formatCheck}
        </button>
        <button
          type="button"
          title={
            formatCheckStatus !== 'passed'
              ? t.importUpload.startImportNeedFormat
              : startImportBlockedByTargetSheetDrift
                ? t.importUpload.startImportTargetSheetsDrift
                : undefined
          }
          className="rounded-[7px] bg-accent px-4 py-1.5 text-il-btn font-medium text-white hover:bg-accent-mid disabled:opacity-60 disabled:cursor-not-allowed"
          disabled={
            queue.length === 0 ||
            importing ||
            formatCheckStatus !== 'passed' ||
            startImportBlockedByTargetSheetDrift
          }
          onClick={() => void startImport()}
        >
          {importing ? t.importUpload.importingNow : t.importUpload.startImport}
        </button>
        <button
          type="button"
          className="rounded-[7px] border border-border bg-white px-4 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent disabled:opacity-60 disabled:cursor-not-allowed"
          disabled={!importing}
          onClick={togglePause}
        >
          {paused ? t.importUpload.resumeImport : t.importUpload.pause}
        </button>
        <button
          type="button"
          title={t.importUpload.importStopHint}
          className="rounded-[7px] border border-border bg-white px-4 py-1.5 text-il-btn text-text-2 hover:border-danger hover:text-danger disabled:opacity-60 disabled:cursor-not-allowed"
          disabled={!importing}
          onClick={() => {
            stopRef.current = true
          }}
        >
          {t.importUpload.importStop}
        </button>
      </div>
    </div>
  )
}

function FormatCheckStandalonePage(props: {
  onNav: (k: NavKey) => void
  onProceedToUploadWithHandoff: (h: ImportWizardHandoff) => void
}) {
  const [queue, setQueue] = useState<PickedExcel[]>([])
  const [sheetKeyOptions, setSheetKeyOptions] = useState<string[]>(() => [...sheetMappingOptionsFallback])
  const [targetSheetKeys, setTargetSheetKeys] = useState<string[]>(() => [...sheetMappingOptionsFallback])
  const [fieldMappingConfig, setFieldMappingConfig] = useState<FieldMappingConfig>(() => FALLBACK_FIELD_MAPPING_CONFIG)
  const [maxUploadMb, setMaxUploadMb] = useState(readStoredMaxUploadMb)
  const [serverMaxUploadMb, setServerMaxUploadMb] = useState<number | null>(null)
  const [formatCheckStatus, setFormatCheckStatus] = useState<'idle' | 'checking' | 'passed' | 'failed'>('idle')
  const [formatCheckHint, setFormatCheckHint] = useState('')
  const [formatCheckBrowserIssues, setFormatCheckBrowserIssues] = useState<string[]>([])
  const [formatCheckYamlIssues, setFormatCheckYamlIssues] = useState<string[]>([])
  const mappingAbortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)

  const effectiveCeiling = useMemo(
    () =>
      serverMaxUploadMb != null && Number.isFinite(serverMaxUploadMb) && serverMaxUploadMb >= 1
        ? Math.floor(serverMaxUploadMb)
        : MAX_IMPORT_FILE_MB,
    [serverMaxUploadMb],
  )

  const persistMaxUploadMb = useCallback(
    (raw: number) => {
      const v = Math.max(1, Math.min(effectiveCeiling, Math.floor(Number(raw))))
      setMaxUploadMb(v)
      try {
        localStorage.setItem(LS_MAX_UPLOAD_MB, String(v))
      } catch {
        /* ignore */
      }
    },
    [effectiveCeiling],
  )

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      const r = await fetchImportLimits(ac.signal)
      if (ac.signal.aborted || !r.ok) return
      setServerMaxUploadMb(r.max_upload_mb)
      setMaxUploadMb((prev) => {
        const cap = r.max_upload_mb
        const v = Math.max(1, Math.min(cap, prev))
        if (v !== prev) {
          try {
            localStorage.setItem(LS_MAX_UPLOAD_MB, String(v))
          } catch {
            /* ignore */
          }
        }
        return v
      })
    })()
    return () => ac.abort()
  }, [])

  const loadSheetMappingOnce = async (source: 'startup' | 'manual') => {
    mappingAbortRef.current?.abort()
    const ac = new AbortController()
    mappingAbortRef.current = ac
    try {
      const opts = await fetchSheetMappingOptions(ac.signal)
      const keys: string[] = []
      const seen = new Set<string>()
      for (const o of opts) {
        const k = String(o.sheet_key ?? '').trim()
        if (!k || seen.has(k)) continue
        seen.add(k)
        keys.push(k)
      }
      if (keys.length > 0) {
        const keySet = new Set(keys)
        const ordered: string[] = [
          ...sheetMappingOptionsFallback.filter((k) => keySet.has(k as string)),
          ...keys.filter((k) => !sheetMappingOptionsFallback.includes(k as any)),
        ] as string[]

        setSheetKeyOptions(ordered)
        setTargetSheetKeys((prev) => {
          const defaultPick = [...ordered]
          if (source === 'startup') return defaultPick
          const kept = prev.filter((k) => ordered.includes(k))
          return kept.length > 0 ? kept : defaultPick
        })
      }
    } catch {
      setSheetKeyOptions([...sheetMappingOptionsFallback])
      setTargetSheetKeys((prev) => {
        if (prev.length > 0) return prev
        return [...sheetMappingOptionsFallback]
      })
    }
  }

  useEffect(() => {
    void loadSheetMappingOnce('startup')
    return () => mappingAbortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      const fm = await fetchFieldMapping(ac.signal)
      if (ac.signal.aborted) return
      if (fm) setFieldMappingConfig(fm)
    })()
    return () => ac.abort()
  }, [])

  const queueSig = useMemo(() => queue.map(queueRowKey).join('\u0001'), [queue])
  const targetSig = useMemo(
    () => [...targetSheetKeys].sort((a, b) => a.localeCompare(b, 'zh-CN')).join('|'),
    [targetSheetKeys],
  )

  useEffect(() => {
    setFormatCheckStatus('idle')
    setFormatCheckHint('')
    setFormatCheckBrowserIssues([])
    setFormatCheckYamlIssues([])
  }, [queueSig, targetSig, maxUploadMb, fieldMappingConfig])

  const addFiles = (items: PickedExcel[]) => {
    if (busyRef.current) return
    const incoming = filterOutOfficeLockFiles(items)
    if (incoming.length === 0) return
    setQueue((prev) => {
      const seen = new Set(
        prev.map((p) => `${p.pathLabel ?? ''}|${p.file.name}:${p.file.size}:${p.file.lastModified}`),
      )
      const next = [...prev]
      for (const { file: f, pathLabel } of incoming) {
        const k = `${pathLabel ?? ''}|${f.name}:${f.size}:${f.lastModified}`
        if (!seen.has(k)) {
          seen.add(k)
          next.push({ file: f, pathLabel })
        }
      }
      return next
    })
  }

  const removeRowsByKeys = (keys: Set<string>) => {
    if (busyRef.current) return
    if (keys.size === 0) return
    setQueue((prev) => prev.filter((r) => !keys.has(queueRowKey(r))))
  }

  const runFormatCheck = async () => {
    if (busyRef.current || queue.length === 0) return
    busyRef.current = true
    setFormatCheckStatus('checking')
    setFormatCheckHint(formatCheckProgressHint(0, queue.length))
    await new Promise<void>((r) => setTimeout(r, 280))

    try {
      const { browserIssues, yamlIssues } = await validateImportQueueFormat({
        queue,
        targetSheetKeys,
        fieldMappingConfig,
        maxUploadMb,
        onProgress: (done, total) => setFormatCheckHint(formatCheckProgressHint(done, total)),
      })

      const total = browserIssues.length + yamlIssues.length
      if (total > 0) {
        setFormatCheckStatus('failed')
        setFormatCheckBrowserIssues(browserIssues)
        setFormatCheckYamlIssues(yamlIssues)
        const parts: string[] = []
        if (browserIssues.length > 0) parts.push(`${browserIssues.length} 项结构/标准字段`)
        if (yamlIssues.length > 0) parts.push(`${yamlIssues.length} 项 YAML 未覆盖表头`)
        setFormatCheckHint(`${t.importUpload.formatFailed}（${parts.join('，')}，见下方分块）`)
        return
      }
      setFormatCheckBrowserIssues([])
      setFormatCheckYamlIssues([])
      setFormatCheckStatus('passed')
      setFormatCheckHint(t.importUpload.formatPassed)
    } finally {
      busyRef.current = false
    }
  }

  const queueTitle =
    queue.length > 0 ? `${t.importUpload.queue}（${queue.length}）` : t.importUpload.queue

  return (
    <div className="flex min-h-0 flex-col p-[22px]">
      <div className="mb-5 shrink-0">
        <div className="mb-2 inline-flex items-center gap-2">
          <span className="text-il-page-title font-semibold text-text">{t.importUpload.formatCheckPageTitle}</span>
        </div>
        <p className="max-w-3xl text-il-page-desc leading-relaxed text-text-2">
          {t.importUpload.formatCheckPageBody}
        </p>
      </div>

      <div className={['mb-4 shrink-0', formatCheckStatus === 'checking' ? 'pointer-events-none opacity-60' : ''].join(' ')}>
        <UploadZone onFiles={addFiles} />
      </div>

      <Card title={t.importUpload.formatCheckParamsCard} className="mb-4 shrink-0">
        <div className="mb-2 flex flex-wrap items-stretch gap-3">
          <div className="w-[92px] shrink-0 sm:w-[100px]">
            <label className="mb-1 block text-il-label font-medium leading-tight text-text-2">
              {t.importUpload.labelMaxFileMb}
            </label>
            <input
              type="number"
              min={1}
              max={effectiveCeiling}
              title={t.importUpload.hintMaxFileMb.replace(/\{mb\}/g, String(effectiveCeiling))}
              className="w-full rounded-[7px] border border-border bg-[#fafbfc] px-2 py-[7px] text-il-input text-text outline-none focus:border-accent focus:bg-white"
              value={maxUploadMb}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (!Number.isFinite(n)) return
                persistMaxUploadMb(n)
              }}
              disabled={formatCheckStatus === 'checking'}
            />
          </div>
        </div>
        <div className="mb-3 text-il-meta leading-snug text-text-3">
          {t.importUpload.hintMaxFileMb.replace(/\{mb\}/g, String(effectiveCeiling))}
        </div>

        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-[12px] font-normal text-text-2">{t.importUpload.targetSheets}</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={formatCheckStatus === 'checking'}
                className={[
                  'rounded-[7px] bg-accent px-4 py-1.5 text-il-btn font-medium text-white hover:bg-accent-mid disabled:cursor-not-allowed disabled:opacity-60',
                  formatCheckStatus === 'checking' ? 'opacity-60' : '',
                ].join(' ')}
                onClick={() => setTargetSheetKeys([...sheetKeyOptions])}
              >
                {t.importUpload.targetSheetsSelectAll}
              </button>
              <button
                type="button"
                disabled={formatCheckStatus === 'checking'}
                className={[
                  'rounded-[7px] border border-border bg-white px-2.5 py-1 text-il-btn text-text-2 hover:border-danger hover:text-danger',
                  formatCheckStatus === 'checking' ? 'opacity-60' : '',
                ].join(' ')}
                onClick={() => setTargetSheetKeys([])}
              >
                {t.importUpload.targetSheetsClearAll}
              </button>
              <button
                type="button"
                disabled={formatCheckStatus === 'checking'}
                className={[
                  'rounded-[7px] border px-2.5 py-1 text-il-btn text-text-2 hover:border-accent hover:text-accent',
                  formatCheckStatus === 'checking' ? 'opacity-60' : '',
                ].join(' ')}
                onClick={() => void loadSheetMappingOnce('manual')}
                title="从本地配置刷新映射"
              >
                {t.importUpload.targetSheetsRefresh}
              </button>
            </div>
          </div>

          <div className={TARGET_SHEET_AREA_SCROLL_CLASS}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-4">
              {sheetKeyOptions.map((k) => {
                const checked = targetSheetKeys.includes(k)
                return (
                  <label
                    key={k}
                    className="mb-1 break-inside-avoid flex cursor-pointer select-none items-center gap-2"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={formatCheckStatus === 'checking'}
                      onChange={() => {
                        setTargetSheetKeys((prev) => {
                          if (prev.includes(k)) return prev.filter((x) => x !== k)
                          return [...prev, k]
                        })
                      }}
                      className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent"
                    />
                    <span className="truncate text-[12px] text-text-2" title={k}>
                      {k}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        </div>
      </Card>

      <Card
        title={queueTitle}
        className="mb-4 shrink-0"
        bodyClassName={queue.length > 0 ? 'max-h-[min(280px,42vh)] overflow-y-auto pr-0.5' : undefined}
      >
        {queue.length === 0 ? (
          <div className="text-il-page-desc text-text-3">{t.importUpload.queueEmpty}</div>
        ) : (
          <ul>
            {queue.map((row, idx) => {
              const f = row.file
              const pathText = row.pathLabel?.trim()
              const key = queueRowKey(row)
              return (
                <li
                  key={key}
                  className="flex gap-2 border-b border-border-light py-2.5 last:border-b-0"
                >
                  <div
                    className="flex flex-shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-white h-[23px] w-[23px] text-il-meta"
                  >
                    {idx + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-text">{f.name}</div>
                    <div className="mt-0.5 text-il-meta text-text-3">
                      {t.importUpload.pendingImport} · {Math.round(f.size / 1024)} KB
                    </div>
                  </div>
                  <div
                    className="min-w-0 flex-1 text-right text-[11px]"
                    title={pathText ? undefined : t.importUpload.pathNotProvidedHint}
                  >
                    {pathText ? (
                      <span className="break-all text-text-2">{pathText}</span>
                    ) : (
                      <span className="text-text-3">{t.importUpload.pathPlaceholder}</span>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-start pt-0">
                    <button
                      type="button"
                      title={t.importUpload.queueRemoveRowTitle}
                      className="rounded px-1.5 py-0.5 text-il-meta text-text-3 hover:bg-[#fff5f5] hover:text-danger"
                      onClick={() => removeRowsByKeys(new Set([key]))}
                      disabled={formatCheckStatus === 'checking'}
                    >
                      {t.importUpload.queueRemoveRow}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <SheetCoveragePanel
        queue={queue}
        knownSheetKeys={sheetKeyOptions}
        disabled={formatCheckStatus === 'checking'}
      />

      {queue.length > 0 ? (
        <div
          className={[
            'mb-2 shrink-0 text-il-page-desc',
            formatCheckStatus === 'passed'
              ? 'text-[#0d7a3e]'
              : formatCheckStatus === 'failed'
                ? 'text-danger'
                : 'text-text-3',
          ].join(' ')}
        >
          {formatCheckStatus === 'idle' && !formatCheckHint ? t.importUpload.formatIdleHint : formatCheckHint}
        </div>
      ) : null}

      {queue.length > 0 &&
      formatCheckStatus === 'failed' &&
      (formatCheckBrowserIssues.length > 0 || formatCheckYamlIssues.length > 0) ? (
        <FormatCheckIssueBlocks
          browserIssues={formatCheckBrowserIssues}
          yamlIssues={formatCheckYamlIssues}
        />
      ) : null}

      <div className="mt-auto flex shrink-0 flex-wrap gap-2 border-t border-border-light bg-bg pt-4">
        <button
          type="button"
          className={[
            'rounded-[7px] border border-accent bg-white px-4 py-1.5 text-il-btn font-medium text-accent hover:bg-[#f0f7ff] disabled:cursor-not-allowed disabled:opacity-60',
          ].join(' ')}
          disabled={queue.length === 0 || formatCheckStatus === 'checking'}
          onClick={() => void runFormatCheck()}
        >
          {formatCheckStatus === 'checking' ? t.importUpload.formatChecking : t.importUpload.formatCheck}
        </button>
        <button
          type="button"
          className="rounded-[7px] bg-accent px-4 py-1.5 text-il-btn font-medium text-white hover:bg-accent-mid disabled:cursor-not-allowed disabled:opacity-60"
          disabled={queue.length === 0 || formatCheckStatus !== 'passed'}
          onClick={() =>
            props.onProceedToUploadWithHandoff({
              queue,
              targetSheetKeys: [...targetSheetKeys],
              maxUploadMb,
            })
          }
        >
          {t.importUpload.formatCheckGoUploadPassed}
        </button>
        <button
          type="button"
          className="rounded-[7px] border border-border bg-white px-4 py-1.5 text-il-btn text-text-2 hover:border-accent hover:text-accent"
          onClick={() => props.onNav('import_wizard_upload')}
        >
          {t.importUpload.formatCheckPageCta}
        </button>
      </div>
    </div>
  )
}

function AppShell(props: {
  user: User
  nav: NavKey
  importHandoff: ImportWizardHandoff | null
  onConsumeImportHandoff: () => void
  onProceedToUploadWithHandoff: (h: ImportWizardHandoff) => void
  onNav: (k: NavKey) => void
  onLogout: () => void
}) {
  useEffect(() => {
    if (canAccessNav(props.user.role, props.nav)) return
    props.onNav(defaultNavForRole(props.user.role))
  }, [props.nav, props.user.role, props.onNav])

  const breadcrumb = useMemo(() => {
    if (props.nav === 'import_wizard_upload')
      return (
        <>
          {t.breadcrumb.invoiceData} / {t.breadcrumb.importWizard} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.fileUpload}</b>
        </>
      )
    if (props.nav === 'import_wizard_format_check')
      return (
        <>
          {t.breadcrumb.invoiceData} / {t.breadcrumb.importWizard} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.formatCheck}</b>
        </>
      )
    if (props.nav === 'import_wizard_ods_overview')
      return (
        <>
          {t.breadcrumb.invoiceData} / {t.breadcrumb.importWizard} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.odsOverview}</b>
        </>
      )
    if (props.nav === 'import_wizard_preview')
      return (
        <>
          {t.breadcrumb.invoiceData} / {t.breadcrumb.importWizard} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dataPreview}</b>
        </>
      )
    if (props.nav === 'ods_to_dwd_center')
      return (
        <>
          {t.breadcrumb.dataFactory} / {t.breadcrumb.processingCenter} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.odsToDwd}</b>
        </>
      )
    if (props.nav === 'dwd_data_preview')
      return (
        <>
          {t.breadcrumb.dataFactory} / {t.breadcrumb.processingCenter} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dwdDataPreview}</b>
        </>
      )
    if (props.nav === 'dwd_to_dim_center')
      return (
        <>
          {t.breadcrumb.dataFactory} / {t.breadcrumb.processingCenter} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dwdToDim}</b>
        </>
      )
    if (props.nav === 'processing_derived_dim_tasks')
      return (
        <>
          {t.breadcrumb.dataFactory} / {t.breadcrumb.processingCenter} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.processingDerivedDimTasks}</b>
        </>
      )
    if (props.nav === 'import_history')
      return (
        <>
          {t.breadcrumb.dataFactory} / <b className="text-text font-medium">{t.breadcrumb.historyBatches}</b>
        </>
      )
    if (props.nav === 'import_mapping_config')
      return (
        <>
          {t.breadcrumb.invoiceData} / {t.breadcrumb.fieldMapping} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.mappingConfig}</b>
        </>
      )
    if (props.nav === 'import_mapping_templates')
      return (
        <>
          {t.breadcrumb.invoiceData} / {t.breadcrumb.fieldMapping} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.mappingTemplates}</b>
        </>
      )
    if (props.nav === 'import_quality_overview')
      return (
        <>
          {t.breadcrumb.dataFactory} / {t.breadcrumb.qualityReport} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.qualityOverview}</b>
        </>
      )
    if (props.nav === 'import_quality_detail')
      return (
        <>
          {t.breadcrumb.dataFactory} / {t.breadcrumb.qualityReport} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.qualityDetail}</b>
        </>
      )
    if (props.nav === 'import_quality_trend')
      return (
        <>
          {t.breadcrumb.dataFactory} / {t.breadcrumb.qualityReport} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.qualityTrend}</b>
        </>
      )
    if (props.nav === 'health_score')
      return (
        <>
          {t.breadcrumb.invoiceData} / <b className="text-text font-medium">{t.breadcrumb.healthScore}</b>
        </>
      )
    if (props.nav === 'entity_profile')
      return (
        <>
          {t.sidebar.sectionAnalysis} / <b className="text-text font-medium">{t.sidebar.entityProfile}</b>
        </>
      )
    if (props.nav === 'overview_summary')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.overview} /{' '}
          <b className="text-text font-medium">{t.sidebar.ovSummary}</b>
        </>
      )
    if (props.nav === 'overview_trend')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.overview} /{' '}
          <b className="text-text font-medium">{t.sidebar.ovTrend}</b>
        </>
      )
    if (props.nav === 'overview_tax')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.overview} /{' '}
          <b className="text-text font-medium">{t.sidebar.ovTax}</b>
        </>
      )
    if (props.nav === 'goods_category')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.taxAnalysis} /{' '}
          <b className="text-text font-medium">{t.sidebar.goodsCategory}</b>
        </>
      )
    if (props.nav === 'red_offset_analysis')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.invoiceBehavior} /{' '}
          <b className="text-text font-medium">{t.sidebar.redOffsetAnalysis}</b>
        </>
      )
    if (props.nav === 'invoice_timing')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.invoiceBehavior} /{' '}
          <b className="text-text font-medium">{t.sidebar.invoiceTiming}</b>
        </>
      )
    if (props.nav === 'counterparty_risk')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.supplier} /{' '}
          <b className="text-text font-medium">{t.sidebar.counterpartyRisk}</b>
        </>
      )
    if (props.nav === 'year_over_year_compare')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.compareAnalysis} /{' '}
          <b className="text-text font-medium">{t.sidebar.yearOverYearCompare}</b>
        </>
      )
    if (props.nav === 'supplier_cr')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.supplier} /{' '}
          <b className="text-text font-medium">{t.sidebar.supplierCr}</b>
        </>
      )
    if (props.nav === 'supplier_top')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.supplier} /{' '}
          <b className="text-text font-medium">{t.sidebar.supplierTop}</b>
        </>
      )
    if (props.nav === 'supplier_new')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.supplier} /{' '}
          <b className="text-text font-medium">{t.sidebar.supplierNew}</b>
        </>
      )
    if (props.nav === 'tax_in_out_deviation')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.taxAnalysis} /{' '}
          <b className="text-text font-medium">{t.sidebar.taxInOutDeviation}</b>
        </>
      )
    if (props.nav === 'tax_risk_exposure')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.taxAnalysis} /{' '}
          <b className="text-text font-medium">{t.sidebar.taxRiskExposure}</b>
        </>
      )
    if (props.nav === 'related_graph')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.related} /{' '}
          <b className="text-text font-medium">{t.sidebar.relatedGraph}</b>
        </>
      )
    if (props.nav === 'import_invoice_export')
      return (
        <>
          {t.breadcrumb.invoiceData} /{' '}
          <b className="text-text font-medium">{t.sidebar.invoiceExport}</b>
        </>
      )
    if (props.nav === 'trade_relationships')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.supplier} /{' '}
          <b className="text-text font-medium">{t.sidebar.tradeRelationships}</b>
        </>
      )
    if (props.nav === 'flags_list')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.flags} /{' '}
          <b className="text-text font-medium">{t.sidebar.flagsList}</b>
        </>
      )
    if (props.nav === 'flags_rules')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.flags} /{' '}
          <b className="text-text font-medium">{t.sidebar.flagsRules}</b>
        </>
      )
    if (props.nav === 'flags_track')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.flags} /{' '}
          <b className="text-text font-medium">{t.sidebar.flagsTrack}</b>
        </>
      )
    if (props.nav === 'related_pairs')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.related} /{' '}
          <b className="text-text font-medium">{t.sidebar.relatedPairs}</b>
        </>
      )
    if (props.nav === 'related_shell')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.related} /{' '}
          <b className="text-text font-medium">{t.sidebar.relatedShell}</b>
        </>
      )
    if (props.nav === 'compare_rank')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.compareAnalysis} / {t.sidebar.compare} /{' '}
          <b className="text-text font-medium">{t.sidebar.compareRank}</b>
        </>
      )
    if (props.nav === 'compare_charts')
      return (
        <>
          {t.sidebar.sectionAnalysis} / {t.sidebar.compareAnalysis} / {t.sidebar.compare} /{' '}
          <b className="text-text font-medium">{t.sidebar.compareCharts}</b>
        </>
      )
    if (props.nav === 'report_config' || props.nav === 'report_archive' || props.nav === 'report_templates')
      return (
        <>
          {t.sidebar.sectionOutput} / {t.sidebar.report} /{' '}
          <b className="text-text font-medium">
            {props.nav === 'report_archive'
              ? t.sidebar.reportArchive
              : props.nav === 'report_templates'
                ? t.sidebar.reportTemplates
                : t.sidebar.reportConfig}
          </b>
        </>
      )
    if (props.nav === 'dim_enterprise_library')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimOrg} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dimEnterpriseLibrary}</b>
        </>
      )
    if (props.nav === 'dim_audit_related_library')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimOrg} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dimAuditRelatedLibrary}</b>
        </>
      )
    if (props.nav === 'dim_level1_enterprise_year')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimOrg} / {t.sidebar.dimAuditedEnterprise} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dimLevel1EnterpriseYear}</b>
        </>
      )
    if (props.nav === 'dim_audited_registry')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimOrg} / {t.sidebar.dimAuditedEnterprise} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dimAuditedLedger}</b>
        </>
      )
    if (props.nav === 'dim_enterprise_year_roster')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimOrg} / {t.sidebar.dimAuditedEnterprise} /{' '}
          <b className="text-text font-medium">{t.sidebar.dimEnterpriseYearRoster}</b>
        </>
      )
    if (props.nav === 'dim_audited_contribution')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimOrg} / {t.sidebar.dimAuditedEnterprise} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dimAuditedContribution}</b>
        </>
      )
    if (props.nav === 'dim_audited_invoice_link')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimOrg} / {t.sidebar.dimAuditedEnterprise} /{' '}
          <b className="text-text font-medium">{t.sidebar.dimInvoiceLink}</b>
        </>
      )
    if (props.nav === 'dim_invoice_to_audited_enterprise')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimOrg} / {t.sidebar.dimAuditedEnterprise} /{' '}
          <b className="text-text font-medium">{t.sidebar.dimInvoiceToAudited}</b>
        </>
      )
    if (props.nav === 'dim_org_sys')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimOrg} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dimOrgSys}</b>
        </>
      )
    if (
      props.nav === 'dim_org_hier_tree' ||
      props.nav === 'dim_org_manage' ||
      props.nav === 'dim_org_equity' ||
      props.nav === 'dim_org_diff'
    )
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimOrg} / {t.sidebar.dimAuditedEnterprise} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dimOrgHierTree}</b>
        </>
      )
    if (props.nav === 'dim_tax_lib')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.breadcrumb.dimTaxCodeSection} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dimTaxLib}</b>
        </>
      )
    if (props.nav === 'dim_tax_risk_define')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.breadcrumb.dimTaxCodeSection} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dimTaxRiskDefine}</b>
        </>
      )
    if (props.nav === 'dim_tax_result')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.breadcrumb.dimTaxCodeSection} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dimTaxResult}</b>
        </>
      )
    if (props.nav === 'dim_tax_quality')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.breadcrumb.dimTaxCodeSection} /{' '}
          <b className="text-text font-medium">{t.breadcrumb.dimTaxQuality}</b>
        </>
      )
    if (props.nav === 'dim_version')
      return (
        <>
          {t.sidebar.dimMgmt} / <b className="text-text font-medium">{t.breadcrumb.dimVersion}</b>
        </>
      )
    if (props.nav === 'dim_dict')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimDict} / <b className="text-text font-medium">{t.breadcrumb.dimDict}</b>
        </>
      )
    if (props.nav === 'dim_subject_category')
      return (
        <>
          {t.sidebar.dimMgmt} / {t.sidebar.dimDict} / <b className="text-text font-medium">{t.breadcrumb.dimSubjectCategory}</b>
        </>
      )
    if (props.nav === 'tax_enterprise_structure')
      return (
        <>
          {t.sidebar.sectionAnalysis} / <b className="text-text font-medium">{t.breadcrumb.taxEnterpriseStructure}</b>
        </>
      )
    if (props.nav === 'finance_reconcile')
      return (
        <>
          {t.sidebar.finance} / <b className="text-text font-medium">{t.breadcrumb.financeReconcile}</b>
        </>
      )
    if (props.nav === 'finance_diff')
      return (
        <>
          {t.sidebar.finance} / <b className="text-text font-medium">{t.breadcrumb.financeDiff}</b>
        </>
      )
    if (props.nav === 'settings_thresholds')
      return (
        <>
          {t.sidebar.settings} / <b className="text-text font-medium">{t.sidebar.settingsThresholds}</b>
        </>
      )
    if (props.nav === 'settings_license')
      return (
        <>
          {t.sidebar.settings} / <b className="text-text font-medium">{t.sidebar.settingsLicense}</b>
        </>
      )
    if (props.nav === 'settings_instance')
      return (
        <>
          {t.sidebar.settings} / <b className="text-text font-medium">{t.sidebar.settingsInstance}</b>
        </>
      )
    return (
      <>
        {t.breadcrumb.invoiceData} / <b className="text-text font-medium">{t.breadcrumb.pending}</b>
      </>
    )
  }, [props.nav])

  return (
    <RbacProvider role={props.user.role}>
      <div className="flex h-screen overflow-hidden">
        <Sidebar nav={props.nav} onNav={props.onNav} user={props.user} onLogout={props.onLogout} />
      <div className="flex flex-1 flex-col overflow-hidden bg-bg">
        <Topbar breadcrumb={breadcrumb} />
        <div
          className={
            props.nav === 'import_wizard_format_check'
              ? 'flex min-h-0 flex-1 flex-col overflow-y-auto'
              : props.nav === 'import_wizard_upload' ||
                  props.nav === 'import_wizard_preview' ||
                  props.nav === 'import_wizard_ods_overview'
                ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                : props.nav === 'dim_enterprise_library'
                  ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                  : 'flex-1 overflow-y-auto'
          }
        >
          {props.nav === 'dwd_to_dim_center' ? (
            <DwdToDimCenterPage onNav={props.onNav} />
          ) : props.nav === 'import_wizard_format_check' ? (
            <FormatCheckStandalonePage
              onNav={props.onNav}
              onProceedToUploadWithHandoff={props.onProceedToUploadWithHandoff}
            />
          ) : props.nav === 'import_wizard_upload' ? (
            <ImportUploadPage
              handoff={props.importHandoff}
              onConsumeHandoff={props.onConsumeImportHandoff}
              onNav={props.onNav}
            />
          ) : props.nav === 'import_wizard_ods_overview' ? (
            <OdsOverviewPage onNav={props.onNav} />
          ) : props.nav === 'import_wizard_preview' ? (
            <DataPreviewPage onNav={props.onNav} />
          ) : props.nav === 'ods_to_dwd_center' ? (
            <OdsToDwdCenterPage />
          ) : props.nav === 'processing_derived_dim_tasks' ? (
            <ProcessingDerivedDimTasksPage onNav={props.onNav} />
          ) : props.nav === 'dwd_data_preview' ? (
            <DwdPreviewPage onNav={props.onNav} />
          ) : props.nav === 'import_history' ? (
            <ImportHistoryPage onNav={props.onNav} />
          ) : props.nav === 'import_mapping_config' ? (
            <FieldMappingConfigPrototype onNavUpload={() => props.onNav('import_wizard_upload')} />
          ) : props.nav === 'import_mapping_templates' ? (
            <MappingTemplatesPrototype onNavMapping={() => props.onNav('import_mapping_config')} />
          ) : props.nav === 'import_quality_overview' ? (
            <DataQualityOverviewPage onNav={props.onNav} />
          ) : props.nav === 'import_quality_detail' ? (
            <DataQualityDetailPage onNav={props.onNav} />
          ) : props.nav === 'import_quality_trend' ? (
            <DataQualityTrendPage onNav={props.onNav} />
          ) : props.nav === 'health_score' ? (
            <HealthScorePage onNav={props.onNav} />
          ) : props.nav === 'entity_profile' ? (
            <EntityProfilePage onNav={props.onNav} />
          ) : props.nav === 'goods_category' ? (
            <GoodsCategoryPage onNav={props.onNav} />
          ) : props.nav === 'red_offset_analysis' ? (
            <RedOffsetAnalysisPage onNav={props.onNav} />
          ) : props.nav === 'invoice_timing' ? (
            <InvoiceTimingPage onNav={props.onNav} />
          ) : props.nav === 'counterparty_risk' ? (
            <CounterpartyRiskPage onNav={props.onNav} />
          ) : props.nav === 'year_over_year_compare' ? (
            <YearOverYearComparePage onNav={props.onNav} />
          ) : props.nav === 'dim_enterprise_library' ? (
            <EnterpriseLibraryPage onNav={props.onNav} />
          ) : props.nav === 'dim_audit_related_library' ? (
            <AuditRelatedEnterprisePage onNav={props.onNav} />
          ) : props.nav === 'dim_level1_enterprise_year' ? (
            <Level1EnterpriseYearPage />
          ) : props.nav === 'dim_audited_registry' ? (
            <AuditedEnterpriseLedgerPage onNav={props.onNav} />
          ) : props.nav === 'dim_enterprise_year_roster' ? (
            <EnterpriseYearRosterPage onNav={(k) => props.onNav(k as NavKey)} />
          ) : props.nav === 'dim_audited_contribution' ? (
            <AuditedEnterpriseContributionPage />
          ) : props.nav === 'dim_audited_invoice_link' ? (
            <AuditedEnterpriseInvoiceLinkPage onNav={props.onNav} />
          ) : props.nav === 'dim_invoice_to_audited_enterprise' ? (
            <InvoiceToAuditedEnterprisePage onNav={props.onNav} />
          ) : props.nav === 'dim_org_sys' ? (
            <DimOrgSysPage onNav={props.onNav} />
          ) : props.nav === 'dim_org_hier_tree' ||
            props.nav === 'dim_org_manage' ||
            props.nav === 'dim_org_equity' ||
            props.nav === 'dim_org_diff' ? (
            <AuditedEnterpriseTreePage
              initialMode={resolveOrgHierInitialMode(props.nav)}
              onNav={props.onNav}
            />
          ) : props.nav === 'dim_tax_lib' ? (
            <TaxCodeLibraryPage mode="manage" onOpenResult={() => props.onNav('dim_tax_result')} />
          ) : props.nav === 'dim_tax_risk_define' ? (
            <TaxCodeRiskDefinePage />
          ) : props.nav === 'dim_tax_result' ? (
            <TaxCodeLibraryPage mode="result" onOpenManage={() => props.onNav('dim_tax_lib')} />
          ) : props.nav === 'dim_tax_quality' ? (
            <TaxCodeAnalysisPage />
          ) : props.nav === 'dim_version' ? (
            <DimVersionPage />
          ) : props.nav === 'dim_dict' ? (
            <DimDictPage onNav={props.onNav} />
          ) : props.nav === 'dim_subject_category' ? (
            <SubjectCategoryPage
              onNavigateToRebuild={() => navToDwdDimWithTask(props.onNav, SUBJECT_DIM_TASK.recompute)}
            />
          ) : props.nav === 'overview_summary' ? (
            <OverviewSummaryPage onNav={props.onNav} />
          ) : props.nav === 'overview_trend' ? (
            <OverviewTrendPage onNav={props.onNav} />
          ) : props.nav === 'overview_tax' ? (
            <OverviewTaxPage onNav={props.onNav} />
          ) : props.nav === 'tax_in_out_deviation' ? (
            <TaxInOutDeviationPage onNav={props.onNav} />
          ) : props.nav === 'tax_risk_exposure' ? (
            <TaxRiskExposurePage onNav={props.onNav} />
          ) : props.nav === 'supplier_cr' ? (
            <SupplierCrPage onNav={props.onNav} />
          ) : props.nav === 'supplier_top' ? (
            <SupplierTopPage onNav={props.onNav} />
          ) : props.nav === 'supplier_new' ? (
            <SupplierNewPage onNav={props.onNav} />
          ) : props.nav === 'flags_list' ? (
            <FlagsListPage onNav={props.onNav} />
          ) : props.nav === 'flags_rules' ? (
            <FlagsRulesPage />
          ) : props.nav === 'flags_track' ? (
            <FlagsTrackPage onNav={props.onNav} />
          ) : props.nav === 'trade_relationships' ? (
            <TradeRelationshipsPage onNav={props.onNav} />
          ) : props.nav === 'related_graph' ? (
            <RelatedGraphPage onNav={props.onNav} />
          ) : props.nav === 'related_pairs' ? (
            <RelatedPairsPage onNav={props.onNav} />
          ) : props.nav === 'related_shell' ? (
            <RelatedShellPage onNav={props.onNav} />
          ) : props.nav === 'compare_rank' ? (
            <CompareRankPage onNav={props.onNav} />
          ) : props.nav === 'compare_charts' ? (
            <CompareChartsPage onNav={props.onNav} />
          ) : props.nav === 'report_config' ? (
            <ReportConfigPage onNav={props.onNav} />
          ) : props.nav === 'report_archive' ? (
            <ReportArchivePage onNav={props.onNav} />
          ) : props.nav === 'report_templates' ? (
            <ReportTemplatesPage />
          ) : props.nav === 'import_invoice_export' ? (
            <InvoiceExportPage />
          ) : props.nav === 'settings_thresholds' ? (
            <SettingsThresholdsPage />
          ) : props.nav === 'settings_license' ? (
            <SettingsLicensePage />
          ) : props.nav === 'settings_instance' ? (
            <SettingsInstancePage onNav={props.onNav} />
          ) : props.nav === 'users_list' ? (
            <UsersListPage currentUser={props.user} />
          ) : props.nav === 'users_roles' ? (
            <UsersRolesPage />
          ) : props.nav === 'users_audit' ? (
            <UsersAuditPage />
          ) : props.nav === 'tax_enterprise_structure' ? (
            <TaxCodeEnterpriseAnalysisPage />
          ) : props.nav === 'finance_reconcile' ? (
            <FinanceReconcilePage onNav={props.onNav} />
          ) : props.nav === 'finance_diff' ? (
            <FinanceDiffPage onNav={props.onNav} />
          ) : (
            <div className="p-6 text-text-2">{t.importUpload.placeholderPage}</div>
          )}
        </div>
      </div>
    </div>
    </RbacProvider>
  )
}

export default function App() {
  const [state, setState] = useState<AppState>({ kind: 'logged_out' })
  const [authChecking, setAuthChecking] = useState(true)
  const [sessionExpired, setSessionExpired] = useState(false)

  const LS_USER = 'invoicelens.demoUser'
  const toUser = (row: {
    username: string
    displayName: string
    role: string
    roleLabel?: string
  }): User => ({
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    roleLabel: row.roleLabel,
  })
  const writeStoredUser = (u: User) => {
    try {
      localStorage.setItem(LS_USER, JSON.stringify(u))
    } catch {
      /* ignore */
    }
  }
  const clearStoredUser = () => {
    try {
      localStorage.removeItem(LS_USER)
    } catch {
      /* ignore */
    }
  }

  const navFromUrl = (): NavKey | null => {
    try {
      const url = new URL(window.location.href)
      const raw = (url.searchParams.get('nav') ?? '').trim()
      if (!raw) return null
      if (raw === 'dim_org_manage' || raw === 'dim_org_equity' || raw === 'dim_org_diff') {
        const treeMode =
          raw === 'dim_org_equity' ? 'equity' : raw === 'dim_org_diff' ? 'relation' : 'management'
        url.searchParams.set('nav', 'dim_org_hier_tree')
        url.searchParams.set('tree_mode', treeMode)
        window.history.replaceState({}, '', url.toString())
        return 'dim_org_hier_tree'
      }
      return raw as NavKey
    } catch {
      return null
    }
  }

  const resolveNav = useCallback((role: string): NavKey => {
    const fromUrl = navFromUrl()
    if (fromUrl && canAccessNav(role, fromUrl)) return fromUrl
    return defaultNavForRole(role)
  }, [])

  const forceLogout = useCallback((expired = false) => {
    setSessionToken(null)
    clearStoredUser()
    setState({ kind: 'logged_out' })
    if (expired) setSessionExpired(true)
  }, [])

  useEffect(() => {
    setAuthExpiredHandler(() => forceLogout(true))
    return () => setAuthExpiredHandler(null)
  }, [forceLogout])

  useEffect(() => {
    const token = getSessionToken()
    if (!token) {
      clearStoredUser()
      setAuthChecking(false)
      return
    }
    const ac = new AbortController()
    void fetchAuthMe(ac.signal).then((res) => {
      if (ac.signal.aborted) return
      setAuthChecking(false)
      if (!res.ok || !res.user) {
        forceLogout(false)
        return
      }
      const u = toUser(res.user)
      writeStoredUser(u)
      setState({
        kind: 'logged_in',
        user: u,
        nav: resolveNav(u.role),
        importHandoff: null,
      })
    })
    return () => ac.abort()
  }, [forceLogout, resolveNav])

  const consumeImportHandoff = useCallback(() => {
    setState((s) => (s.kind === 'logged_in' ? { ...s, importHandoff: null } : s))
  }, [])
  const proceedToUploadWithHandoff = useCallback((h: ImportWizardHandoff) => {
    setState((s) => {
      if (s.kind !== 'logged_in') return s
      const nav = canAccessNav(s.user.role, 'import_wizard_upload')
        ? 'import_wizard_upload'
        : defaultNavForRole(s.user.role)
      return { ...s, importHandoff: h, nav }
    })
  }, [])

  const handleLogout = useCallback(() => {
    void postAuthLogout().finally(() => forceLogout(false))
  }, [forceLogout])

  if (authChecking) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-bg text-text-2">
        {t.common.sessionChecking}
      </div>
    )
  }

  if (state.kind === 'logged_out') {
    return (
      <LoginScreen
        sessionExpired={sessionExpired}
        onLogin={(user) => {
          setSessionExpired(false)
          writeStoredUser(user)
          setState({
            kind: 'logged_in',
            user,
            nav: resolveNav(user.role),
            importHandoff: null,
          })
        }}
      />
    )
  }
  return (
    <AppShell
      user={state.user}
      nav={state.nav}
      importHandoff={state.importHandoff}
      onConsumeImportHandoff={consumeImportHandoff}
      onProceedToUploadWithHandoff={proceedToUploadWithHandoff}
      onNav={(nav) => setState((s) => (s.kind === 'logged_in' ? { ...s, nav } : s))}
      onLogout={handleLogout}
    />
  )
}
