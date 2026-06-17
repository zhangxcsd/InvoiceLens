const _envBase = (import.meta as any).env?.VITE_LOCAL_API_BASE?.toString?.()?.trim?.() ?? ''

/**
 * 本地 API 根地址。
 * - 未设置 VITE_LOCAL_API_BASE 且为 Vite 开发模式：空字符串，请求走相对路径 `/api/*`，由 vite 代理到 8765（与页面同源，少踩跨域）。
 * - 显式设置 VITE_LOCAL_API_BASE：始终直连该地址（可绕过代理）。
 * - 生产构建默认：`http://127.0.0.1:8765`（静态部署时请按需改为反代或环境变量）。
 */
export const LOCAL_API_BASE =
  _envBase.length > 0
    ? _envBase.replace(/\/$/, '')
    : import.meta.env.DEV
      ? ''
      : 'http://127.0.0.1:8765'

function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return LOCAL_API_BASE ? `${LOCAL_API_BASE}${p}` : p
}

const SESSION_TOKEN_KEY = 'il_session_token'
const REMEMBER_SESSION_KEY = 'il_remember_session'

function activeTokenStorage(): Storage | null {
  try {
    if (localStorage.getItem(REMEMBER_SESSION_KEY) === '1') return localStorage
    return sessionStorage
  } catch {
    return null
  }
}

export function isRememberSession(): boolean {
  try {
    return localStorage.getItem(REMEMBER_SESSION_KEY) === '1'
  } catch {
    return false
  }
}

export function setRememberSession(remember: boolean): void {
  try {
    if (remember) localStorage.setItem(REMEMBER_SESSION_KEY, '1')
    else localStorage.removeItem(REMEMBER_SESSION_KEY)
  } catch {
    /* noop */
  }
}

export function getSessionToken(): string | null {
  try {
    const store = activeTokenStorage()
    if (!store) return null
    return store.getItem(SESSION_TOKEN_KEY)
  } catch {
    return null
  }
}

export function setSessionToken(token: string | null, remember?: boolean): void {
  try {
    if (remember !== undefined) setRememberSession(remember)
    const primary = (remember ?? isRememberSession()) ? localStorage : sessionStorage
    const secondary = primary === localStorage ? sessionStorage : localStorage
    if (token) {
      primary.setItem(SESSION_TOKEN_KEY, token)
      secondary.removeItem(SESSION_TOKEN_KEY)
    } else {
      sessionStorage.removeItem(SESSION_TOKEN_KEY)
      localStorage.removeItem(SESSION_TOKEN_KEY)
    }
  } catch {
    /* noop */
  }
}

function withAuthHeaders(init?: RequestInit): RequestInit {
  const token = getSessionToken()
  if (!token) return init ?? {}
  const headers = new Headers(init?.headers ?? {})
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
  if (!headers.has('X-Session-Token')) headers.set('X-Session-Token', token)
  return { ...init, headers }
}

type AuthExpiredHandler = () => void
let authExpiredHandler: AuthExpiredHandler | null = null

/** App 挂载时注册：apiFetch 收到 401 时清除会话并回到登录页 */
export function setAuthExpiredHandler(handler: AuthExpiredHandler | null): void {
  authExpiredHandler = handler
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(apiUrl(path), withAuthHeaders(init))
  if (res.status === 401 && path !== '/api/auth/login') {
    setSessionToken(null)
    authExpiredHandler?.()
  }
  return res
}

/** React 依赖重跑 / 卸载时 AbortController 取消 fetch，不应当作业务错误展示 */
export function isFetchAbortError(e: unknown): boolean {
  if (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError') {
    return true
  }
  if (e instanceof Error && e.name === 'AbortError') return true
  return false
}

function subjectCategoryApiCandidates(): string[] {
  const primary = apiUrl('/api/subject-category/rules')
  // 开发态优先走 Vite 同源代理；若代理链路异常则回退直连本地 API。
  if (LOCAL_API_BASE) return [primary]
  const fallback = 'http://127.0.0.1:8765/api/subject-category/rules'
  return primary === fallback ? [primary] : [primary, fallback]
}

export type SheetMappingOption = {
  sheet_key: string
  table_type?: string
}

export type ApiImportEvent = {
  import_session_id: string
  event_id: number
  ts: string
  type: string
  payload: Record<string, unknown>
}

/** 与 config/field_mapping.yaml 字段节点一致：label_zh 为业务含义；aliases 为表头别名 */
export type FieldMappingFieldEntry = {
  label_zh: string
  aliases: string[]
}

export type FieldMappingConfig = {
  default_fields: Record<string, FieldMappingFieldEntry>
  sheets?: Record<string, Record<string, FieldMappingFieldEntry>>
}

function normalizeFieldEntry(raw: unknown): FieldMappingFieldEntry | null {
  if (Array.isArray(raw)) {
    return { label_zh: '', aliases: raw.map((x) => String(x)) }
  }
  if (raw && typeof raw === 'object' && 'aliases' in (raw as object)) {
    const o = raw as Record<string, unknown>
    const al = o.aliases
    if (!Array.isArray(al)) return null
    return {
      label_zh: o.label_zh != null ? String(o.label_zh).trim() : '',
      aliases: al.map((x) => String(x)),
    }
  }
  return null
}

/** 含服务端来源说明，便于界面展示 */
export type FieldMappingWithMeta = FieldMappingConfig & { source?: string }

/** 服务端单文件硬顶（MB），来自 INVOICELENS_MAX_UPLOAD_MB；用于界面参数上限与本地校验对齐 */
export async function fetchImportLimits(signal?: AbortSignal): Promise<{
  ok: boolean
  max_upload_mb: number
}> {
  const res = await apiFetch('/api/import-limits', { signal })
  const json = (await res.json().catch(() => ({}))) as any
  const mb = Number(json?.max_upload_mb)
  if (!res.ok || !json?.ok || !Number.isFinite(mb) || mb < 1) {
    return { ok: false, max_upload_mb: 0 }
  }
  return { ok: true, max_upload_mb: Math.floor(mb) }
}

/** 与 `config/field_mapping.yaml` 一致；API 不可用时前端使用 `FALLBACK_FIELD_MAPPING_CONFIG` */
export type HeaderCoverageSheet = {
  sheet_name: string
  matched_target_keys?: string[]
  header_row_found?: boolean
  unmapped_headers: string[]
  suggested_slugs: Record<string, string>
}

export type HeaderCoverageResponse = {
  ok: boolean
  file?: string
  sheets?: HeaderCoverageSheet[]
  update_hint?: string
  error?: { message?: string; detail?: string; exception_type?: string }
}

/** 表头是否在 YAML（含 sheet_header_slugs）中覆盖；与 excel_to_ods 列推断对齐 */
export async function postHeaderCoverage(
  file: File,
  targetKeys: string[],
  signal?: AbortSignal,
  maxUploadMb?: number,
): Promise<HeaderCoverageResponse | null> {
  const fd = new FormData()
  fd.append('target_sheet_keys', JSON.stringify(targetKeys))
  fd.append('client_max_upload_mb', String(Math.max(1, Math.floor(maxUploadMb ?? 200))))
  fd.append('files', file, file.name)
  try {
    const res = await apiFetch('/api/header-coverage', {
      method: 'POST',
      body: fd,
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as HeaderCoverageResponse
    if (!json || typeof json !== 'object') return null
    return json
  } catch {
    return null
  }
}

export async function fetchFieldMapping(
  signal?: AbortSignal,
): Promise<FieldMappingWithMeta | null> {
  try {
    const res = await apiFetch('/api/field-mapping', { signal })
    if (!res.ok) return null
    const json = (await res.json()) as any

    if (!json?.ok) return null

    const defaultRaw = json.default_fields ?? json.fields
    if (defaultRaw == null || typeof defaultRaw !== 'object') return null

    const default_fields: Record<string, FieldMappingFieldEntry> = {}
    for (const [k, v] of Object.entries(defaultRaw as any)) {
      const ent = normalizeFieldEntry(v)
      if (ent) default_fields[String(k)] = ent
    }

    const sheets: Record<string, Record<string, FieldMappingFieldEntry>> = {}
    if (json.sheets != null && typeof json.sheets === 'object') {
      for (const [sheetKey, v] of Object.entries(json.sheets as any)) {
        if (v == null || typeof v !== 'object') continue
        const fm: Record<string, FieldMappingFieldEntry> = {}
        for (const [field, raw] of Object.entries(v as any)) {
          const ent = normalizeFieldEntry(raw)
          if (ent) fm[String(field)] = ent
        }
        if (Object.keys(fm).length > 0) sheets[String(sheetKey)] = fm
      }
    }

    if (Object.keys(default_fields).length === 0) return null
    const source = json.source != null ? String(json.source) : undefined
    return { default_fields, sheets, source }
  } catch {
    return null
  }
}

/** 任务码 dim.enterprise_year_rel.rebuild：按花名册成员 × DWD 按年重算 dim_enterprise_year_rel */
export type EnterpriseYearRelMetaResult = {
  ok: boolean
  automation_task_code?: string
  dwd_stat_years?: string[]
  roster_stat_years?: string[]
  /** @deprecated 与 roster_stat_years 同义，保留兼容 */
  group_stat_years?: string[]
  rel_rebuild_union_stat_years?: string[]
  dim_enterprise_year_rel_row_counts_by_year?: Record<string, number>
  error?: { message?: string; exception_type?: string; detail?: string }
}

export type EnterpriseYearRelRebuildResult = {
  ok: boolean
  skipped?: boolean
  dry_run?: boolean
  automation_task_code?: string
  stat_years?: number[]
  relation_build_run_id?: string
  relation_snapshot_id?: string
  rows_before_delete?: number
  rows_after_insert?: number
  aggregated_subject_year_rows?: number
  rows_that_would_insert?: number
  message?: string
  error?: { message?: string; exception_type?: string; detail?: string }
}

/** 与 `enterprise_year_rel_build.AUTOMATION_TASK_CODE` 一致；用于加工中心运行记录筛选 */
export const DIM_ENTERPRISE_YEAR_REL_TASK_CODE = 'dim.enterprise_year_rel.rebuild' as const

/** POST /api/dwd/build：ODS→DWD 落盘（run_cleaner） */
export type DwdBuildStep = { id: string; label: string; status: string; detail?: string }

export type DwdBuildResult =
  | {
      ok: true
      import_batch_id: string
      /** 仅单年构建时有值；多年度时为 null，见 stat_years_built */
      stat_year: number | null
      stat_year_source: string
      /** 本次实际依次构建的 stat_year 列表（未传请求体 stat_year 时由 ODS 推断） */
      stat_years_built?: number[]
      incremental?: boolean
      message?: string
      force_rebuild?: boolean
      import_session_id?: string
      cleaner: Record<string, unknown>
      cleaner_by_year?: Array<Record<string, unknown>>
      steps: DwdBuildStep[]
      dwd_row_estimate: number
      build_run_id?: string
      log_file?: string
      retry_step_id?: string
      single_step_only?: boolean
      /** 请求体 rebuild_enterprise_year_rel 为 true 且构建成功时，附带年度关系重算结果 */
      enterprise_year_rel_rebuild?: EnterpriseYearRelRebuildResult
    }
  | {
      ok: false
      import_batch_id?: string
      stat_year?: number
      stat_years_planned?: number[]
      stat_years_built?: number[]
      stat_years_succeeded?: number[]
      failed_stat_year?: number | null
      stat_year_source?: string
      error?: {
        message?: string
        code?: string
        detail?: string
        exception_type?: string
        stat_year_source?: string
      }
    }

export async function postDwdBuild(
  params: {
    import_batch_id: string
    stat_year?: number
    /** 默认 true：仅处理尚未写入 DWD 水位的 import_session */
    incremental?: boolean
    /** 为 true 时等价于 incremental: false，全量重跑该批次（不按水位跳过） */
    full_batch?: boolean
    /**
     * 与 incremental 联用：仅处理列表中属于「待增量」的会话（与后端 pending 取交集）。
     * 不传则该批次下全部待处理会话。
     */
    import_session_ids?: string[]
    /** 为 true 时：DWD 构建成功后按本次 stat_years_built 重算 dim_enterprise_year_rel */
    rebuild_enterprise_year_rel?: boolean
    /** 为 true 时：DWD 构建成功后按本次 stat_years_built 刷新 DWS 五表 */
    refresh_dws?: boolean
  },
  signal?: AbortSignal,
): Promise<DwdBuildResult & { httpStatus: number }> {
  const res = await apiFetch('/api/dwd/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      import_batch_id: params.import_batch_id,
      ...(params.stat_year != null ? { stat_year: params.stat_year } : {}),
      ...(params.incremental != null ? { incremental: params.incremental } : {}),
      ...(params.full_batch === true ? { full_batch: true } : {}),
      ...(params.import_session_ids != null && params.import_session_ids.length > 0
        ? { import_session_ids: params.import_session_ids }
        : {}),
      ...(params.rebuild_enterprise_year_rel === true ? { rebuild_enterprise_year_rel: true } : {}),
      ...(params.refresh_dws === true ? { refresh_dws: true } : {}),
    }),
    signal,
  })
  const json = (await res.json().catch(() => ({}))) as DwdBuildResult
  return { ...json, httpStatus: res.status }
}

/** POST /api/dwd/force-rebuild：运维强制重洗（删 DWD 行 + 重置水位 + 重跑） */
export async function postDwdForceRebuild(
  params: {
    import_batch_id: string
    import_session_id: string
    stat_year?: number
    rebuild_enterprise_year_rel?: boolean
    refresh_dws?: boolean
  },
  signal?: AbortSignal,
): Promise<DwdBuildResult & { httpStatus: number; force_rebuild?: boolean; import_session_id?: string }> {
  const res = await apiFetch('/api/dwd/force-rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      import_batch_id: params.import_batch_id,
      import_session_id: params.import_session_id,
      ...(params.stat_year != null ? { stat_year: params.stat_year } : {}),
      ...(params.rebuild_enterprise_year_rel === true ? { rebuild_enterprise_year_rel: true } : {}),
      ...(params.refresh_dws === true ? { refresh_dws: true } : {}),
    }),
    signal,
  })
  const json = (await res.json().catch(() => ({}))) as DwdBuildResult & {
    force_rebuild?: boolean
    import_session_id?: string
  }
  return { ...json, httpStatus: res.status }
}

/** POST /api/dwd/retry-step：单步重跑 cleaner（standardize / write_dwd / validate） */
export async function postDwdRetryStep(
  params: {
    import_batch_id: string
    step_id: string
    stat_year?: number
    import_session_ids?: string[]
    rebuild_enterprise_year_rel?: boolean
    refresh_dws?: boolean
  },
  signal?: AbortSignal,
): Promise<DwdBuildResult & { httpStatus: number }> {
  const res = await apiFetch('/api/dwd/retry-step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      import_batch_id: params.import_batch_id,
      step_id: params.step_id,
      ...(params.stat_year != null ? { stat_year: params.stat_year } : {}),
      ...(params.import_session_ids != null && params.import_session_ids.length > 0
        ? { import_session_ids: params.import_session_ids }
        : {}),
      ...(params.rebuild_enterprise_year_rel === true ? { rebuild_enterprise_year_rel: true } : {}),
      ...(params.refresh_dws === true ? { refresh_dws: true } : {}),
    }),
    signal,
  })
  const json = (await res.json().catch(() => ({}))) as DwdBuildResult
  return { ...json, httpStatus: res.status }
}

export function dwdBuildLogDownloadUrl(runId: string): string {
  const base = import.meta.env.VITE_LOCAL_API_BASE?.trim() || ''
  const q = new URLSearchParams({ run_id: runId, download: '1' })
  return `${base}/api/dwd/build-log?${q.toString()}`
}

/** POST /api/dwd/rollback：删除批次 DWD 行并重置水位（不删 ODS） */
export async function postDwdRollback(params: {
  import_batch_id: string
}): Promise<{
  ok: boolean
  deleted_rows_by_table?: Record<string, number>
  ods_sessions_reset?: number
  error?: { message?: string; detail?: string; code?: string }
}> {
  try {
    const res = await apiFetch('/api/dwd/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ import_batch_id: params.import_batch_id }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      deleted_rows_by_table:
        json.deleted_rows_by_table && typeof json.deleted_rows_by_table === 'object'
          ? Object.fromEntries(
              Object.entries(json.deleted_rows_by_table as Record<string, unknown>).map(([k, v]) => [
                k,
                Number(v ?? 0),
              ]),
            )
          : undefined,
      ods_sessions_reset: json.ods_sessions_reset != null ? Number(json.ods_sessions_reset) : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DimEnterpriseProfileBuildResult = {
  ok: boolean
  async?: boolean
  message?: string
  stage?: string
  run_id?: string
  calc_batch_id?: string
  source_scope?: string
  subject_category_scope?: string
  stat_month?: string | null
  import_batch_id?: string | null
  enterprise_upserted?: number
  profile_rows_written?: number
  error?: { message?: string; detail?: string; exception_type?: string }
}

export type DimTaskBuildResult = {
  ok: boolean
  async?: boolean
  message?: string
  task_code?: string
  stage?: string
  run_id?: string
  import_batch_id?: string | null
  rows_affected?: number
  error?: { message?: string; detail?: string; exception_type?: string }
}

export type DimUnifiedTaskRow = {
  task_no?: number
  task_code: string
  task_name: string
  domain: string
  subject_category: string
  layer?: string
  query_group?: string
  query_group_label?: string
  output_table: string
  purpose?: string
  output_desc?: string
  query_desc?: string
  trigger_modes: string[]
  depends_on: string[]
  soft_depends_on?: string[]
  owner: string
  status: string
  queue_depth: number
  last_started_at: string
  last_finished_at: string
  last_duration_ms: number
  last_run_status: string
  last_error_message: string
  running_run_id: string
  progress_step: string
  progress_message: string
  elapsed_ms: number
}

export type DimActiveRunRow = {
  run_id: string
  task_code: string
  task_name: string
  status: string
  started_at: string
  progress_step: string
  progress_message: string
  elapsed_ms: number
}

export type DimTasksResponse = {
  ok: boolean
  registry?: DimUnifiedTaskRow[]
  tasks: DimUnifiedTaskRow[]
  active_runs: DimActiveRunRow[]
  failed_recent: Array<{
    task_code: string
    task_name: string
    error_message: string
    last_fail_at: string
    run_id: string
  }>
  stats: {
    running_count?: number
    queued_count?: number
    queue_depth_total?: number
  }
  error?: { message?: string }
}

export type DimTaskRunStatusResponse = {
  ok: boolean
  run_id?: string
  task_code?: string
  task_name?: string
  status?: string
  rows_affected?: number
  error_message?: string
  started_at?: string
  finished_at?: string
  duration_ms?: number
  progress_step?: string
  progress_message?: string
  elapsed_ms?: number
  error?: { message?: string }
}

export type DimTaskRunLogRow = {
  run_id: string
  task_code: string
  task_name: string
  status: string
  trigger_source: string
  run_mode: string
  rows_affected: number
  error_message: string
  calc_batch_id: string
  import_batch_id: string
  started_at: string
  finished_at: string
  duration_ms: number
}

/** POST /api/dim/build-enterprise-profile：DWD→DIM 企业画像聚合 */
export async function postDimEnterpriseProfileBuild(
  params: {
    stat_month?: string
    import_batch_id?: string
    calc_batch_id?: string
    source_scope?: string
    subject_category_scope?: string
    run_id?: string
  },
  signal?: AbortSignal,
): Promise<DimEnterpriseProfileBuildResult & { httpStatus: number }> {
  const res = await apiFetch('/api/dim/build-enterprise-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      async: true,
      ...(params.stat_month ? { stat_month: params.stat_month } : {}),
      ...(params.import_batch_id ? { import_batch_id: params.import_batch_id } : {}),
      ...(params.calc_batch_id ? { calc_batch_id: params.calc_batch_id } : {}),
      ...(params.source_scope ? { source_scope: params.source_scope } : {}),
      ...(params.subject_category_scope ? { subject_category_scope: params.subject_category_scope } : {}),
      ...(params.run_id ? { run_id: params.run_id } : {}),
    }),
    signal,
  })
  const json = (await res.json().catch(() => ({}))) as DimEnterpriseProfileBuildResult
  return { ...json, httpStatus: res.status }
}

/** POST /api/dim/build-enterprise-master：DWD→DIM 企业主数据构建 */
export async function postDimEnterpriseMasterBuild(
  params: { import_batch_id?: string; subject_category_scope?: string; run_id?: string },
  signal?: AbortSignal,
): Promise<DimTaskBuildResult & { httpStatus: number }> {
  const res = await apiFetch('/api/dim/build-enterprise-master', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      async: true,
      ...(params.import_batch_id ? { import_batch_id: params.import_batch_id } : {}),
      ...(params.subject_category_scope ? { subject_category_scope: params.subject_category_scope } : {}),
      ...(params.run_id ? { run_id: params.run_id } : {}),
    }),
    signal,
  })
  const json = (await res.json().catch(() => ({}))) as DimTaskBuildResult
  return { ...json, httpStatus: res.status }
}

/** POST /api/dim/build-enterprise-mapping：DWD→DIM 企业映射状态构建 */
export async function postDimEnterpriseMappingBuild(
  params: { import_batch_id?: string; subject_category_scope?: string; run_id?: string },
  signal?: AbortSignal,
): Promise<DimTaskBuildResult & { httpStatus: number }> {
  const res = await apiFetch('/api/dim/build-enterprise-mapping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      async: true,
      ...(params.import_batch_id ? { import_batch_id: params.import_batch_id } : {}),
      ...(params.subject_category_scope ? { subject_category_scope: params.subject_category_scope } : {}),
      ...(params.run_id ? { run_id: params.run_id } : {}),
    }),
    signal,
  })
  const json = (await res.json().catch(() => ({}))) as DimTaskBuildResult
  return { ...json, httpStatus: res.status }
}

/** GET /api/dim/enterprise-year-rel/meta */
export async function fetchDimEnterpriseYearRelMeta(
  signal?: AbortSignal,
): Promise<EnterpriseYearRelMetaResult & { httpStatus: number }> {
  const res = await apiFetch('/api/dim/enterprise-year-rel/meta', { signal })
  const json = (await res.json().catch(() => ({}))) as EnterpriseYearRelMetaResult
  return { ...json, httpStatus: res.status }
}

/** POST /api/dim/enterprise-year-rel/rebuild：显式按年重算（可与导入编排串联） */
export async function postDimEnterpriseYearRelRebuild(
  params: {
    /** 省略或 null：按 dwd_inv_header 全部 stat_year；可传数字数组或逗号分隔字符串 */
    stat_years?: number[] | string | null
    dry_run?: boolean
    run_id?: string
    relation_snapshot_id?: string
    /** 写入运行台账 ads_etl_task_run_log.trigger_source */
    trigger_source?: string
  },
  signal?: AbortSignal,
): Promise<EnterpriseYearRelRebuildResult & { httpStatus: number }> {
  const res = await apiFetch('/api/dim/enterprise-year-rel/rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(params.stat_years !== undefined ? { stat_years: params.stat_years } : {}),
      ...(params.dry_run ? { dry_run: true } : {}),
      ...(params.run_id ? { run_id: params.run_id } : {}),
      ...(params.relation_snapshot_id ? { relation_snapshot_id: params.relation_snapshot_id } : {}),
      ...(params.trigger_source ? { trigger_source: params.trigger_source } : {}),
    }),
    signal,
  })
  const json = (await res.json().catch(() => ({}))) as EnterpriseYearRelRebuildResult
  return { ...json, httpStatus: res.status }
}

export async function fetchDimTaskRuns(
  params: { task_code?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ ok: boolean; runs: DimTaskRunLogRow[]; error?: { message?: string; detail?: string } }> {
  const qs = new URLSearchParams()
  if (params.task_code) qs.set('task_code', params.task_code)
  if (params.limit != null) qs.set('limit', String(params.limit))
  const url = `${apiUrl('/api/dim/task-runs')}${qs.toString() ? `?${qs.toString()}` : ''}`
  const res = await fetch(url, { signal })
  const json = (await res.json().catch(() => ({}))) as any
  if (!res.ok || !json?.ok) {
    return { ok: false, runs: [], error: json?.error }
  }
  return { ok: true, runs: Array.isArray(json.runs) ? (json.runs as DimTaskRunLogRow[]) : [] }
}

/** GET /api/dim/tasks：统一任务清单 + 活动运行 + 失败摘要 */
export async function fetchDimTasks(signal?: AbortSignal): Promise<DimTasksResponse & { httpStatus: number }> {
  const res = await apiFetch('/api/dim/tasks', { signal })
  const json = (await res.json().catch(() => ({}))) as DimTasksResponse
  return { ...json, httpStatus: res.status }
}

/** GET /api/dim/task-run-status?run_id= */
export async function fetchDimTaskRunStatus(
  runId: string,
  signal?: AbortSignal,
): Promise<DimTaskRunStatusResponse & { httpStatus: number }> {
  const qs = new URLSearchParams({ run_id: runId })
  const res = await apiFetch(`/api/dim/task-run-status?${qs.toString()}`, { signal })
  const json = (await res.json().catch(() => ({}))) as DimTaskRunStatusResponse
  return { ...json, httpStatus: res.status }
}

export type DimTaskChainStepRow = {
  step_id?: string
  step_code?: string
  task_code?: string
  label?: string
  status?: string
  started_at?: string | null
  finished_at?: string | null
  duration_ms?: number | null
  error_message?: string | null
  retry_count?: number
  ok?: boolean
  run_id?: string
  result?: Record<string, unknown>
}

export type DimTaskChainRunSummary = {
  run_id?: string
  parent_run_id?: string | null
  started_at?: string | null
  finished_at?: string | null
  overall_status?: string
  status?: string
  message?: string
  stat_years?: number[]
  instance_snapshot?: Record<string, unknown>
  steps?: DimTaskChainStepRow[]
  active?: boolean
}

export type DimTaskChainInstanceSnapshot = {
  default_stat_year?: number | null
  min_analysis_subject_invoice_count?: number
  instance_id?: string
}

/** POST /api/dim/task-chain/run */
export async function postDimTaskChainRun(
  body: {
    statYears?: number[] | null
    overwriteManualRepairs?: boolean
    withRelations?: boolean
    skipSubjectPipeline?: boolean
  } = {},
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  async?: boolean
  run_id?: string
  task_code?: string
  steps?: string[]
  message?: string
  error?: { message?: string }
}> {
  const res = await apiFetch('/api/dim/task-chain/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stat_years: body.statYears === undefined ? undefined : body.statYears,
      overwrite_manual_repairs: body.overwriteManualRepairs === true,
      with_relations: body.withRelations !== false,
      skip_subject_pipeline: body.skipSubjectPipeline === true,
    }),
    signal,
  })
  return (await res.json().catch(() => ({}))) as {
    ok: boolean
    async?: boolean
    run_id?: string
    task_code?: string
    steps?: string[]
    message?: string
    error?: { message?: string }
  }
}

/** GET /api/dim/task-chain/status?run_id= */
export async function fetchDimTaskChainStatus(
  runId: string,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  run_id?: string
  status?: string
  overall_status?: string
  step?: string
  message?: string
  started_at?: string | null
  finished_at?: string | null
  steps?: DimTaskChainStepRow[]
  stat_years?: number[]
  instance_snapshot?: DimTaskChainInstanceSnapshot
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}> {
  const qs = new URLSearchParams({ run_id: runId })
  const res = await apiFetch(`/api/dim/task-chain/status?${qs.toString()}`, { signal })
  return (await res.json().catch(() => ({}))) as {
    ok: boolean
    run_id?: string
    status?: string
    overall_status?: string
    step?: string
    message?: string
    started_at?: string | null
    finished_at?: string | null
    steps?: DimTaskChainStepRow[]
    stat_years?: number[]
    instance_snapshot?: DimTaskChainInstanceSnapshot
    params?: Record<string, unknown>
    result?: Record<string, unknown>
    error?: { message?: string }
  }
}

/** GET /api/dim/task-chain/runs?limit= */
export async function fetchDimTaskChainRuns(
  params: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ ok: boolean; runs?: DimTaskChainRunSummary[]; active_run_ids?: string[]; error?: { message?: string } }> {
  const qs = new URLSearchParams()
  if (params.limit != null) qs.set('limit', String(params.limit))
  const res = await apiFetch(`/api/dim/task-chain/runs?${qs.toString()}`, { signal })
  return (await res.json().catch(() => ({}))) as {
    ok: boolean
    runs?: DimTaskChainRunSummary[]
    active_run_ids?: string[]
    error?: { message?: string }
  }
}

/** POST /api/dim/task-chain/retry-step */
export async function postDimTaskChainRetryStep(
  body: { runId: string; stepId: string; continueChain?: boolean },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  async?: boolean
  run_id?: string
  step_id?: string
  retry_count?: number
  continue_chain?: boolean
  message?: string
  error?: { message?: string }
}> {
  const res = await apiFetch('/api/dim/task-chain/retry-step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      run_id: body.runId,
      step_id: body.stepId,
      continue_chain: body.continueChain !== false,
    }),
    signal,
  })
  return (await res.json().catch(() => ({}))) as {
    ok: boolean
    async?: boolean
    run_id?: string
    step_id?: string
    retry_count?: number
    message?: string
    error?: { message?: string }
  }
}

/** POST /api/subject-library/pipeline：主体库一键全流程（后台） */
export async function postSubjectLibraryPipeline(
  params: { overwrite_manual_repairs?: boolean; with_relations?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ ok: boolean; async?: boolean; run_id?: string; message?: string; error?: { message?: string } }> {
  const res = await apiFetch('/api/subject-library/pipeline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      overwrite_manual_repairs: params.overwrite_manual_repairs === true,
      with_relations: params.with_relations !== false,
    }),
    signal,
  })
  return (await res.json().catch(() => ({}))) as {
    ok: boolean
    async?: boolean
    run_id?: string
    message?: string
    error?: { message?: string }
  }
}

/** GET /api/subject-library/pipeline-status?run_id= */
export async function fetchSubjectLibraryPipelineStatus(
  runId: string,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  run_id?: string
  status?: string
  step?: string
  message?: string
  result?: Record<string, unknown>
  error?: { message?: string }
}> {
  const qs = new URLSearchParams({ run_id: runId })
  const res = await apiFetch(`/api/subject-library/pipeline-status?${qs.toString()}`, { signal })
  return (await res.json().catch(() => ({}))) as {
    ok: boolean
    run_id?: string
    status?: string
    step?: string
    message?: string
    result?: Record<string, unknown>
    error?: { message?: string }
  }
}

export async function saveFieldMapping(
  cfg: FieldMappingConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; source?: string; saved_to?: string; error?: string }> {
  const sheets = cfg.sheets ?? {}
  try {
    const res = await apiFetch('/api/field-mapping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        default_fields: cfg.default_fields,
        sheets,
      }),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      const msg =
        json?.error?.message != null ? String(json.error.message) : `保存失败（HTTP ${res.status}）`
      return { ok: false, error: msg }
    }
    return {
      ok: true,
      source: json.source != null ? String(json.source) : undefined,
      saved_to: json.saved_to != null ? String(json.saved_to) : undefined,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : '网络错误'
    return { ok: false, error: msg }
  }
}

export type FieldMappingTemplateSummary = {
  template_id: string
  name: string
  description?: string
  is_builtin: boolean
  is_active?: boolean
  default_field_count?: number
  sheet_count?: number
  updated_at?: string
  sample_excel_count?: number
}

export type FieldMappingTemplateSample = {
  filename: string
  size_bytes?: number
  updated_at?: string
}

export type FieldMappingTemplateDetail = FieldMappingTemplateSummary & {
  default_fields: Record<string, FieldMappingFieldEntry>
  sheets: Record<string, Record<string, FieldMappingFieldEntry>>
  samples?: FieldMappingTemplateSample[]
}

export async function fetchFieldMappingTemplates(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  templates?: FieldMappingTemplateSummary[]
  active_template_id?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/field-mapping/templates/list', { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const templates: FieldMappingTemplateSummary[] = Array.isArray(json.templates)
      ? json.templates.map((t: any) => ({
          template_id: String(t.template_id ?? ''),
          name: String(t.name ?? ''),
          description: t.description ? String(t.description) : undefined,
          is_builtin: Boolean(t.is_builtin),
          is_active: Boolean(t.is_active),
          default_field_count: Number(t.default_field_count ?? 0),
          sheet_count: Number(t.sheet_count ?? 0),
          updated_at: t.updated_at ? String(t.updated_at) : undefined,
          sample_excel_count: Number(t.sample_excel_count ?? 0),
        }))
      : []
    return {
      ok: true,
      templates,
      active_template_id: json.active_template_id ? String(json.active_template_id) : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchFieldMappingTemplate(
  templateId: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; aborted?: boolean; template?: FieldMappingTemplateDetail; error?: { message?: string } }> {
  try {
    const q = new URLSearchParams({ template_id: templateId })
    const res = await apiFetch(`/api/field-mapping/templates/get?${q}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok || !json.template) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const t = json.template
    const default_fields: Record<string, FieldMappingFieldEntry> = {}
    for (const [k, v] of Object.entries(t.default_fields ?? {})) {
      const ent = normalizeFieldEntry(v)
      if (ent) default_fields[String(k)] = ent
    }
    const sheets: Record<string, Record<string, FieldMappingFieldEntry>> = {}
    if (t.sheets && typeof t.sheets === 'object') {
      for (const [sk, block] of Object.entries(t.sheets as Record<string, unknown>)) {
        if (!block || typeof block !== 'object') continue
        const fm: Record<string, FieldMappingFieldEntry> = {}
        for (const [fk, raw] of Object.entries(block as Record<string, unknown>)) {
          const ent = normalizeFieldEntry(raw)
          if (ent) fm[String(fk)] = ent
        }
        if (Object.keys(fm).length > 0) sheets[String(sk)] = fm
      }
    }
    return {
      ok: true,
      template: {
        template_id: String(t.template_id ?? ''),
        name: String(t.name ?? ''),
        description: t.description ? String(t.description) : undefined,
        is_builtin: Boolean(t.is_builtin),
        is_active: Boolean(t.is_active),
        default_field_count: Number(t.default_field_count ?? 0),
        sheet_count: Number(t.sheet_count ?? 0),
        updated_at: t.updated_at ? String(t.updated_at) : undefined,
        sample_excel_count: Number(t.sample_excel_count ?? 0),
        samples: Array.isArray(t.samples)
          ? t.samples.map((s: any) => ({
              filename: String(s.filename ?? ''),
              size_bytes: s.size_bytes != null ? Number(s.size_bytes) : undefined,
              updated_at: s.updated_at ? String(s.updated_at) : undefined,
            }))
          : [],
        default_fields,
        sheets,
      },
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postFieldMappingTemplateCreate(body: {
  name: string
  description?: string
  source_template_id?: string
}): Promise<{ ok: boolean; created?: boolean; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/field-mapping/templates/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true, created: Boolean(json.created) }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postFieldMappingTemplateSave(body: {
  template_id: string
  name: string
  description?: string
  default_fields?: Record<string, FieldMappingFieldEntry>
  sheets?: Record<string, Record<string, FieldMappingFieldEntry>>
}): Promise<{ ok: boolean; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/field-mapping/templates/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postFieldMappingTemplateDelete(templateId: string): Promise<{
  ok: boolean
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/field-mapping/templates/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: templateId }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postFieldMappingTemplateActivate(templateId: string): Promise<{
  ok: boolean
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/field-mapping/templates/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: templateId }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postFieldMappingTemplatePreviewZip(params: {
  file: File
}): Promise<{
  ok: boolean
  preview?: {
    name?: string
    manifest_template_id?: string | null
    has_conflict?: boolean
    conflict?: { template_id?: string; existing_name?: string; import_name?: string }
    sample_excel_count?: number
    sample_read_errors?: string[]
  }
  error?: { message?: string; code?: string }
}> {
  try {
    const fd = new FormData()
    fd.append('file', params.file, params.file.name)
    const res = await apiFetch('/api/field-mapping/templates/import-zip/preview', {
      method: 'POST',
      body: fd,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '预览失败' } }
    return { ok: true, preview: json.preview }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postFieldMappingTemplateImportZip(params: {
  file: File
  nameOverride?: string
  overwrite?: boolean
  activate?: boolean
}): Promise<{
  ok: boolean
  template_id?: string
  created?: boolean
  overwritten?: boolean
  activated?: boolean
  summary?: FieldMappingTemplateSummary
  import_meta?: {
    source_filename?: string
    sample_excel_count?: number
    sample_persisted_count?: number
    sample_persisted_files?: string[]
    manifest_template_id?: string | null
    sample_read_errors?: string[]
  }
  error?: { message?: string; code?: string }
}> {
  try {
    const fd = new FormData()
    fd.append('file', params.file, params.file.name)
    if (params.nameOverride?.trim()) fd.append('name', params.nameOverride.trim())
    if (params.overwrite) fd.append('overwrite', '1')
    if (params.activate) fd.append('activate', '1')
    const res = await apiFetch('/api/field-mapping/templates/import-zip', {
      method: 'POST',
      body: fd,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '导入失败' } }
    const summaryRaw = json.summary ?? json.template
    const summary: FieldMappingTemplateSummary | undefined = summaryRaw
      ? {
          template_id: String(summaryRaw.template_id ?? json.template_id ?? ''),
          name: String(summaryRaw.name ?? ''),
          description: summaryRaw.description ? String(summaryRaw.description) : undefined,
          is_builtin: Boolean(summaryRaw.is_builtin),
          is_active: Boolean(summaryRaw.is_active),
          default_field_count: Number(summaryRaw.default_field_count ?? 0),
          sheet_count: Number(summaryRaw.sheet_count ?? 0),
          updated_at: summaryRaw.updated_at ? String(summaryRaw.updated_at) : undefined,
          sample_excel_count: Number(summaryRaw.sample_excel_count ?? 0),
        }
      : undefined
    return {
      ok: true,
      template_id: json.template_id ? String(json.template_id) : summary?.template_id,
      created: json.created,
      overwritten: json.overwritten,
      activated: json.activated,
      summary,
      import_meta: json.import_meta,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchFieldMappingTemplateExportZip(templateId: string): Promise<{
  ok: boolean
  blob?: Blob
  fileName?: string
  error?: { message?: string }
}> {
  try {
    const q = new URLSearchParams({ template_id: templateId })
    const res = await apiFetch(`/api/field-mapping/templates/export-zip?${q}`)
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as any
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') ?? ''
    const m = /filename="?([^";]+)"?/.exec(cd)
    return { ok: true, blob, fileName: m?.[1] ?? 'template.zip' }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchFieldMappingTemplateSampleDownload(
  templateId: string,
  filename: string,
): Promise<{ ok: boolean; blob?: Blob; fileName?: string; error?: { message?: string } }> {
  try {
    const q = new URLSearchParams({ template_id: templateId, filename })
    const res = await apiFetch(`/api/field-mapping/templates/sample-download?${q}`)
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as any
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') ?? ''
    const m = /filename="?([^";]+)"?/.exec(cd)
    return { ok: true, blob, fileName: m?.[1] ?? filename }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchSheetMappingOptions(signal?: AbortSignal): Promise<SheetMappingOption[]> {
  const url = `${apiUrl('/api/sheet-mapping')}?include_table_type=1`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`fetch sheet-mapping failed: ${res.status}`)
  const json = (await res.json()) as any
  const options = (json?.options ?? []) as any[]
  return options
    .map((o) => ({
      sheet_key: String(o.sheet_key ?? '').trim(),
      table_type: o.table_type != null ? String(o.table_type) : undefined,
    }))
    .filter((o) => o.sheet_key.length > 0)
}

/**
 * 浏览器无磁盘路径：按文件逐个 POST（每请求仅 1 个 File），避免整包 multipart 过大拖垮内存；
 * 全部落盘后再调用 start-import，仍对应单次导入会话与同一 import_session_id 事件流。
 */
export async function createImportSessionUpload(params: {
  batchDate: string
  failPolicy: 'stop' | 'skip'
  forceReimport?: boolean
  targetSheetKeys: string[]
  /** 用户设置的「单文件上限」MB，服务端会再与 INVOICELENS_MAX_UPLOAD_MB 取较小值 */
  maxUploadMb: number
  files: { file: File; pathLabel?: string }[]
  /** ODS 落盘成功后自动对该会话做增量 DWD（事件流 post_dwd_*） */
  autoDwdAfterImport?: boolean
  /** 需与 autoDwdAfterImport 同时为 true 才生效 */
  rebuildEnterpriseYearRelAfterDwd?: boolean
  /** 省略时使用服务端当前激活模板 */
  fieldMappingTemplateId?: string
  signal?: AbortSignal
  /** 每成功上传一个文件后回调（done 从 1 递增；亦可用于 UI 显示 0/total 由调用方在调用前自行展示） */
  onUploadProgress?: (done: number, total: number) => void
}): Promise<string> {
  const {
    batchDate,
    failPolicy,
    forceReimport,
    targetSheetKeys,
    maxUploadMb,
    files,
    signal,
    onUploadProgress,
    autoDwdAfterImport,
    rebuildEnterpriseYearRelAfterDwd,
    fieldMappingTemplateId,
  } = params
  const autoDwd = autoDwdAfterImport === true
  const rebuildRel = rebuildEnterpriseYearRelAfterDwd === true && autoDwd
  if (files.length === 0) throw new Error('no files')

  let importSessionId = ''
  const tsk = JSON.stringify(targetSheetKeys)
  const clientCap = String(Math.max(1, Math.floor(maxUploadMb)))
  const total = files.length

  for (let i = 0; i < files.length; i += 1) {
    const row = files[i]!
    const fd = new FormData()
    fd.append('batch_id', batchDate)
    fd.append('fail_policy', failPolicy)
    fd.append('force_reimport', forceReimport ? '1' : '0')
    fd.append('target_sheet_keys', tsk)
    fd.append('path_label', row.pathLabel ?? '')
    fd.append('client_max_upload_mb', clientCap)
    fd.append('auto_dwd_after_import', autoDwd ? '1' : '0')
    fd.append('rebuild_enterprise_year_rel', rebuildRel ? '1' : '0')
    if (fieldMappingTemplateId) fd.append('field_mapping_template_id', fieldMappingTemplateId)
    if (importSessionId) fd.append('import_session_id', importSessionId)
    fd.append('files', row.file, row.file.name)

    const res = await apiFetch('/api/import-sessions/upload-file', {
      method: 'POST',
      body: fd,
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      const msg = json?.error?.message || `upload-file failed (${res.status})`
      throw new Error(msg)
    }
    importSessionId = String(json.import_session_id)
    onUploadProgress?.(i + 1, total)
  }

  const resStart = await fetch(
    apiUrl(`/api/import-sessions/${encodeURIComponent(importSessionId)}/start-import`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auto_dwd_after_import: autoDwd,
        rebuild_enterprise_year_rel: rebuildRel,
      }),
      signal,
    },
  )
  const jStart = (await resStart.json().catch(() => ({}))) as any
  if (!resStart.ok || !jStart?.ok) {
    const msg = jStart?.error?.message || `start-import failed (${resStart.status})`
    throw new Error(msg)
  }
  return importSessionId
}

export async function fetchImportSessionEvents(
  importSessionId: string,
  afterEventId: number,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  events: ApiImportEvent[]
  next_after_event_id: number
  finished: boolean
  error?: { message?: string }
}> {
  const url = `${apiUrl(`/api/import-sessions/${encodeURIComponent(importSessionId)}/events`)}?after_event_id=${afterEventId}`
  const res = await fetch(url, { signal })
  const json = (await res.json()) as any
  return {
    ok: Boolean(json?.ok),
    events: Array.isArray(json?.events) ? json.events : [],
    next_after_event_id: Number(json?.next_after_event_id ?? afterEventId),
    finished: Boolean(json?.finished),
    error: json?.error,
  }
}

/** ODS数据查看：批次列表（来自 DuckDB ods_load_log） */
export type OdsPreviewBatchMeta = {
  batch_id: string
  session_id: string
  load_time: string
  file_count: number
  /** 该次导入会话写入 ODS 的总行数（ods_load_log，含各 sheet 合计口径） */
  total_rows: number
  success_count: number
  fail_count: number
  warn_count: number
  parquet_path_count: number
  /** 该会话在 DWD 中已落盘行数（按 import_batch_id + import_session_id 汇总） */
  dwd_header_rows: number
  dwd_detail_rows: number
  /** 该会话完成增量 DWD 构建的时间（ods_load_log.dwd_session_processed_at），未构建为空串 */
  dwd_session_processed_at?: string
}

export type OdsPreviewColumn = { field: string; label_zh: string }

export type OdsPreviewTablePack = {
  table_type: string
  parquet_files?: number
  field_mapping_sheet_key?: string
  columns: OdsPreviewColumn[]
  rows: Array<Record<string, string>>
}

export function odsPreviewBatchKey(m: { batch_id: string; session_id: string }): string {
  return `${m.batch_id}::${m.session_id}`
}

export async function fetchOdsPreviewBatches(
  signal?: AbortSignal,
  limit = 80,
): Promise<{
  ok: boolean
  batches: OdsPreviewBatchMeta[]
  ods_dir_hint?: string
  error?: { message?: string; detail?: string }
}> {
  try {
    const res = await apiFetch(`/api/ods-preview/batches?limit=${limit}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        batches: [],
        ods_dir_hint: json?.ods_dir_hint != null ? String(json.ods_dir_hint) : undefined,
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    const raw = Array.isArray(json.batches) ? json.batches : []
    const batches: OdsPreviewBatchMeta[] = raw.map((r: any) => ({
      batch_id: String(r?.batch_id ?? ''),
      session_id: String(r?.session_id ?? ''),
      load_time: String(r?.load_time ?? ''),
      file_count: Number(r?.file_count ?? 0),
      total_rows: Number(r?.total_rows ?? 0),
      success_count: Number(r?.success_count ?? 0),
      fail_count: Number(r?.fail_count ?? 0),
      warn_count: Number(r?.warn_count ?? 0),
      parquet_path_count: Number(r?.parquet_path_count ?? 0),
      dwd_header_rows: Number(r?.dwd_header_rows ?? 0),
      dwd_detail_rows: Number(r?.dwd_detail_rows ?? 0),
      dwd_session_processed_at:
        r?.dwd_session_processed_at != null && String(r.dwd_session_processed_at).trim() !== ''
          ? String(r.dwd_session_processed_at)
          : undefined,
    }))
    return {
      ok: true,
      batches,
      ods_dir_hint: json.ods_dir_hint != null ? String(json.ods_dir_hint) : undefined,
    }
  } catch (e) {
    return {
      ok: false,
      batches: [],
      error: { message: e instanceof Error ? e.message : '网络错误' },
      ods_dir_hint: undefined,
    }
  }
}

export type OdsImportSessionSummary = {
  ok: boolean
  batch_id?: string
  session_id?: string
  field_mapping_template?: {
    template_id: string
    template_name: string
    template_updated_at: string
  } | null
  failure_summary?: {
    row_reject_count: number
    file_blocking_count: number
    reject_sample_count: number
    import_file_count: number
  }
  fail_files?: Array<{
    file_name: string
    status: string
    file_blocking: boolean
    reason: string
    exception_type?: string | null
  }>
  reject_row_samples?: Array<{
    seq_no?: number | string | null
    sheet: string
    field?: string | null
    reason: string
    exception_type?: string | null
    source_excel_file?: string | null
  }>
  reject_row_ranges?: Array<{
    seq_no_start?: number | string | null
    seq_no_end?: number | string | null
    reason: string
    source_excel_file?: string | null
  }>
  fetch_warning?: string | null
  error?: { message?: string; detail?: string }
}

export async function fetchOdsImportSessionSummary(
  params: { batchId: string; sessionId: string; sampleLimit?: number },
  signal?: AbortSignal,
): Promise<OdsImportSessionSummary> {
  try {
    const q = new URLSearchParams()
    q.set('batch_id', params.batchId)
    q.set('session_id', params.sessionId)
    if (params.sampleLimit != null) q.set('sample_limit', String(params.sampleLimit))
    const res = await apiFetch(`/api/ods-preview/session-summary?${q.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const tmpl = json.field_mapping_template
    return {
      ok: true,
      batch_id: json.batch_id != null ? String(json.batch_id) : undefined,
      session_id: json.session_id != null ? String(json.session_id) : undefined,
      field_mapping_template:
        tmpl && typeof tmpl === 'object'
          ? {
              template_id: String(tmpl.template_id ?? ''),
              template_name: String(tmpl.template_name ?? ''),
              template_updated_at: String(tmpl.template_updated_at ?? ''),
            }
          : null,
      failure_summary: json.failure_summary ?? undefined,
      fail_files: Array.isArray(json.fail_files) ? json.fail_files : [],
      reject_row_samples: Array.isArray(json.reject_row_samples) ? json.reject_row_samples : [],
      reject_row_ranges: Array.isArray(json.reject_row_ranges) ? json.reject_row_ranges : [],
      fetch_warning: json.fetch_warning != null ? String(json.fetch_warning) : null,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** 拉取某会话下各表类型的抽样行（Parquet union_by_name） */
export async function fetchOdsPreviewSession(
  batchId: string,
  sessionId: string,
  signal?: AbortSignal,
  rowLimit = 400,
  view: 'std' | 'raw' = 'std',
  params?: { meta_only?: boolean; only_table_type?: string; include_counts?: boolean },
): Promise<{
  ok: boolean
  tables?: Record<string, OdsPreviewTablePack>
  /** 与 sheet_mapping.yaml 顺序一致的有数据 Tab 标题列表 */
  tab_order?: string[]
  /** Tab 顺序+对应 table_type（用于懒加载） */
  tab_order_meta?: Array<{ title: string; table_type: string }>
  /** table_type -> 落盘总行数（COUNT） */
  row_counts?: Record<string, number>
  row_limit_applied?: number
  warnings?: string[]
  load_time?: string
  file_count?: number
  success_count?: number
  fail_count?: number
  warn_count?: number
  view?: 'std' | 'raw'
  ods_dir_used?: string
  error?: { message?: string; detail?: string }
}> {
  const q = new URLSearchParams({
    batch_id: batchId,
    session_id: sessionId,
    row_limit: String(rowLimit),
    view,
  })
  if (params?.meta_only) q.set('meta_only', '1')
  if (params?.only_table_type) q.set('only_table_type', String(params.only_table_type))
  if (params?.include_counts) q.set('include_counts', '1')
  try {
    const res = await apiFetch(`/api/ods-preview/session?${q}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    const tables: Record<string, OdsPreviewTablePack> = {}
    const rawT = json.tables
    if (rawT != null && typeof rawT === 'object') {
      for (const [tabKey, pack] of Object.entries(rawT)) {
        const p = pack as any
        if (!p || typeof p !== 'object') continue
        const cols = Array.isArray(p.columns) ? p.columns : []
        const columns: OdsPreviewColumn[] = cols
          .map((c: any) => ({
            field: String(c?.field ?? ''),
            // 后端为 snake_case；兼容误传的 camelCase（勿在空时回退为 field，否则易与第一行英文重复）
            label_zh: String(c?.label_zh ?? c?.labelZh ?? '').trim(),
          }))
          .filter((c: OdsPreviewColumn) => c.field.length > 0)
        const rows = Array.isArray(p.rows) ? (p.rows as Array<Record<string, string>>) : []
        tables[String(tabKey)] = {
          table_type: String(p.table_type ?? ''),
          parquet_files: p.parquet_files != null ? Number(p.parquet_files) : undefined,
          field_mapping_sheet_key:
            p.field_mapping_sheet_key != null ? String(p.field_mapping_sheet_key) : undefined,
          columns,
          rows: rows.map((row) => {
            const out: Record<string, string> = {}
            for (const [k, v] of Object.entries(row)) {
              out[String(k)] = v != null ? String(v) : ''
            }
            return out
          }),
        }
      }
    }
    const tab_order = Array.isArray(json.tab_order)
      ? (json.tab_order as unknown[]).map((x) => String(x)).filter((s) => s.length > 0)
      : []
    const tab_order_meta = Array.isArray(json.tab_order_meta)
      ? (json.tab_order_meta as any[])
          .map((x) => ({
            title: String(x?.title ?? '').trim(),
            table_type: String(x?.table_type ?? '').trim(),
          }))
          .filter((x) => x.title.length > 0 && x.table_type.length > 0)
      : []
    const row_counts: Record<string, number> = {}
    if (json.row_counts && typeof json.row_counts === 'object') {
      for (const [k, v] of Object.entries(json.row_counts as any)) {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) continue
        row_counts[String(k)] = Math.floor(n)
      }
    }
    return {
      ok: true,
      tables,
      tab_order,
      tab_order_meta,
      row_counts,
      row_limit_applied: json.row_limit_applied != null ? Number(json.row_limit_applied) : undefined,
      warnings: Array.isArray(json.warnings) ? json.warnings.map((w: any) => String(w)) : [],
      load_time: json.load_time != null ? String(json.load_time) : undefined,
      file_count: json.file_count != null ? Number(json.file_count) : undefined,
      success_count: json.success_count != null ? Number(json.success_count) : undefined,
      fail_count: json.fail_count != null ? Number(json.fail_count) : undefined,
      warn_count: json.warn_count != null ? Number(json.warn_count) : undefined,
      view: json.view === 'raw' ? 'raw' : 'std',
      ods_dir_used: json.ods_dir_used != null ? String(json.ods_dir_used) : undefined,
    }
  } catch (e) {
    return {
      ok: false,
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

/** 仅拉取会话 Tab 元信息（不读 parquet 行），用于首屏加速 */
export async function fetchOdsPreviewSessionMeta(
  batchId: string,
  sessionId: string,
  signal?: AbortSignal,
  view: 'std' | 'raw' = 'std',
): Promise<{
  ok: boolean
  tab_order?: string[]
  tab_order_meta?: Array<{ title: string; table_type: string }>
  row_counts?: Record<string, number>
  warnings?: string[]
  error?: { message?: string; detail?: string }
}> {
  const r = await fetchOdsPreviewSession(batchId, sessionId, signal, 1, view, { meta_only: true })
  if (!r.ok) return { ok: false, error: r.error }
  return {
    ok: true,
    tab_order: r.tab_order ?? [],
    tab_order_meta: r.tab_order_meta ?? [],
    row_counts: r.row_counts ?? {},
    warnings: r.warnings ?? [],
  }
}

/** 按需计算某个 table_type 的落盘总行数（COUNT） */
export async function fetchOdsPreviewTableCount(params: {
  batchId: string
  sessionId: string
  tableType: string
  signal?: AbortSignal
  view?: 'std' | 'raw'
}): Promise<{ ok: boolean; table_type: string; count?: number; error?: { message?: string; detail?: string } }> {
  const { batchId, sessionId, tableType, signal, view } = params
  const r = await fetchOdsPreviewSession(batchId, sessionId, signal, 1, view ?? 'std', {
    meta_only: true,
    include_counts: true,
    only_table_type: tableType,
  })
  if (!r.ok) return { ok: false, table_type: tableType, error: r.error }
  const n = r.row_counts?.[tableType]
  return { ok: true, table_type: tableType, count: typeof n === 'number' ? n : undefined }
}

/** 仅拉取会话中某个 table_type 的表数据（用于 Tab 懒加载） */
export async function fetchOdsPreviewSessionTable(
  batchId: string,
  sessionId: string,
  tableType: string,
  signal?: AbortSignal,
  rowLimit = 400,
  view: 'std' | 'raw' = 'std',
): Promise<{
  ok: boolean
  tables?: Record<string, OdsPreviewTablePack>
  tab_order?: string[]
  tab_order_meta?: Array<{ title: string; table_type: string }>
  row_limit_applied?: number
  warnings?: string[]
  error?: { message?: string; detail?: string }
}> {
  const r = await fetchOdsPreviewSession(batchId, sessionId, signal, rowLimit, view, {
    only_table_type: tableType,
  })
  if (!r.ok) return { ok: false, error: r.error }
  return {
    ok: true,
    tables: r.tables ?? {},
    tab_order: r.tab_order ?? [],
    tab_order_meta: r.tab_order_meta ?? [],
    row_limit_applied: r.row_limit_applied,
    warnings: r.warnings ?? [],
  }
}

function _normalizeOdsPreviewRows(rows: Array<Record<string, unknown>>): Array<Record<string, string>> {
  return rows.map((row) => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(row)) {
      out[String(k)] = v != null ? String(v) : ''
    }
    return out
  })
}

/** DWD 预览：invoice_date 固定为 YYYY-MM-DD（避免 T00:00:00 等中间层序列化） */
function _normalizeDwdPreviewRows(rows: Array<Record<string, string>>): Array<Record<string, string>> {
  return rows.map((row) => {
    const d = row.invoice_date
    if (d == null || d.length < 10) return row
    if (d[4] !== '-' || d[7] !== '-') return row
    const head = d.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) return row
    if (d === head) return row
    return { ...row, invoice_date: head }
  })
}

/**
 * 旧版本地 API 无 `/api/ods-preview/table-page` 时，用会话抽样接口凑一页（无游标分页）。
 * `tables` 的 key 为 Tab 中文标题，需 `tabTitleHint` 或唯一表包。
 */
async function _odsPreviewTablePageViaSessionFallback(params: {
  batchId: string
  sessionId: string
  tableType: string
  tabTitleHint?: string
  signal?: AbortSignal
  view?: 'std' | 'raw'
  rowLimit?: number
}): Promise<{
  ok: boolean
  columns?: OdsPreviewColumn[]
  rows?: Array<Record<string, string>>
  has_more?: boolean
  next_cursor?: Record<string, unknown> | null
  limit?: number
  field_mapping_sheet_key?: string
  warnings?: string[]
  error?: { message?: string; detail?: string }
}> {
  const { batchId, sessionId, tableType, tabTitleHint, signal, view = 'std', rowLimit = 400 } = params
  const leg = await fetchOdsPreviewSessionTable(batchId, sessionId, tableType, signal, rowLimit, view)
  if (!leg.ok) return { ok: false, error: leg.error }
  const tables = leg.tables ?? {}
  const hint = (tabTitleHint ?? '').trim()
  const pack =
    (hint && tables[hint]) ||
    Object.values(tables).find((p) => (p.table_type ?? '') === tableType) ||
    Object.values(tables)[0]
  if (!pack) {
    return {
      ok: true,
      columns: [],
      rows: [],
      has_more: false,
      next_cursor: null,
      limit: leg.row_limit_applied ?? rowLimit,
      warnings: leg.warnings ?? [],
    }
  }
  const columns: OdsPreviewColumn[] = (pack.columns ?? [])
    .map((c) => ({
      field: String(c.field ?? ''),
      label_zh: String(c.label_zh ?? '').trim(),
    }))
    .filter((c) => c.field.length > 0)
  const rows = _normalizeOdsPreviewRows((pack.rows ?? []) as Array<Record<string, unknown>>)
  return {
    ok: true,
    columns,
    rows,
    has_more: false,
    next_cursor: null,
    limit: leg.row_limit_applied ?? rowLimit,
    field_mapping_sheet_key: pack.field_mapping_sheet_key,
    warnings: leg.warnings ?? [],
  }
}

/** 单表游标分页预览（首屏 + 「加载更多」）；404 时自动回退旧版 `/api/ods-preview/session` */
export async function fetchOdsPreviewTablePage(params: {
  batchId: string
  sessionId: string
  tableType: string
  limit?: number
  cursor?: Record<string, unknown> | null
  signal?: AbortSignal
  view?: 'std' | 'raw'
  /** 与后端 `tables` 的 key 一致（Tab 标题），404 回退时用于定位表包 */
  tabTitleHint?: string
}): Promise<{
  ok: boolean
  columns?: OdsPreviewColumn[]
  rows?: Array<Record<string, string>>
  has_more?: boolean
  next_cursor?: Record<string, unknown> | null
  limit?: number
  field_mapping_sheet_key?: string
  warnings?: string[]
  error?: { message?: string; detail?: string }
}> {
  const { batchId, sessionId, tableType, limit = 200, cursor, signal, view = 'std', tabTitleHint } = params
  const q = new URLSearchParams({
    batch_id: batchId,
    session_id: sessionId,
    table_type: tableType,
    limit: String(Math.max(1, Math.min(1000, Math.floor(limit)))),
    view,
  })
  if (cursor && typeof cursor === 'object') {
    q.set('cursor', JSON.stringify(cursor))
  }
  try {
    const res = await apiFetch(`/api/ods-preview/table-page?${q}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any

    if (res.status === 404 && !cursor) {
      return _odsPreviewTablePageViaSessionFallback({
        batchId,
        sessionId,
        tableType,
        tabTitleHint,
        signal,
        view,
        rowLimit: Math.max(400, Math.floor(limit)),
      })
    }

    if (!res.ok || !json?.ok) {
      const base = json?.error ?? { message: `HTTP ${res.status}` }
      if (res.status === 404 && cursor) {
        return {
          ok: false,
          error: {
            message:
              '本地 API 无分页接口（返回 404）。请重启本地 API 为当前仓库版本后再使用「加载更多」，或刷新页面将尝试整批抽样。',
            detail: base?.detail != null ? String(base.detail) : undefined,
          },
        }
      }
      return { ok: false, error: base }
    }

    const cols = Array.isArray(json.columns) ? json.columns : []
    const columns: OdsPreviewColumn[] = cols
      .map((c: any) => ({
        field: String(c?.field ?? ''),
        label_zh: String(c?.label_zh ?? c?.labelZh ?? '').trim(),
      }))
      .filter((c: OdsPreviewColumn) => c.field.length > 0)
    const rowsRaw = Array.isArray(json.rows) ? json.rows : []
    const rows = _normalizeOdsPreviewRows(rowsRaw as Array<Record<string, unknown>>)
    const next_cursor =
      json.next_cursor != null && typeof json.next_cursor === 'object' && !Array.isArray(json.next_cursor)
        ? (json.next_cursor as Record<string, unknown>)
        : null
    return {
      ok: true,
      columns,
      rows,
      has_more: Boolean(json.has_more),
      next_cursor,
      limit: json.limit != null ? Number(json.limit) : undefined,
      field_mapping_sheet_key:
        json.field_mapping_sheet_key != null ? String(json.field_mapping_sheet_key) : undefined,
      warnings: Array.isArray(json.warnings) ? json.warnings.map((w: any) => String(w)) : [],
    }
  } catch (e) {
    return {
      ok: false,
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export type DwdPreviewTabMeta = {
  dwd_table: string
  title: string
  layer: 'header' | 'detail'
  row_count: number
}

/** GET /api/dwd-preview/tabs：与 ODS 表类型顺序一致的 DWD Tab（仅含血缘可匹配且行数>0） */
export async function fetchDwdPreviewTabs(params: {
  batchId: string
  sessionId: string
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  tabs?: DwdPreviewTabMeta[]
  warnings?: string[]
  error?: { message?: string; detail?: string }
}> {
  const { batchId, sessionId, signal } = params
  const q = new URLSearchParams({
    batch_id: batchId,
    session_id: sessionId,
  })
  try {
    const res = await apiFetch(`/api/dwd-preview/tabs?${q}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const raw = Array.isArray(json.tabs) ? json.tabs : []
    // 强约束：仅接受 dwd_table。若后端仍返回旧结构（table_type），直接报错提示升级/重启 API。
    const hasLegacyOnly =
      raw.length > 0 &&
      raw.some((t: any) => String(t?.dwd_table ?? '').trim() === '' && String(t?.table_type ?? '').trim() !== '')
    if (hasLegacyOnly) {
      return {
        ok: false,
        error: {
          message:
            '本地 API 返回了旧版 DWD tabs 结构（table_type）。请重启并更新本地 API，使 /api/dwd-preview/tabs 返回 dwd_table 字段。',
        },
      }
    }
    const tabs: DwdPreviewTabMeta[] = raw
      .map((t: any) => ({
        dwd_table: String(t?.dwd_table ?? '').trim(),
        title: String(t?.title ?? t?.dwd_table ?? '').trim(),
        layer: t?.layer === 'header' ? 'header' : 'detail',
        row_count: Number(t?.row_count ?? 0),
      }))
      .filter((t: DwdPreviewTabMeta) => t.dwd_table.length > 0)
    const warnings = Array.isArray(json.warnings) ? json.warnings.map((w: any) => String(w)) : []
    return { ok: true, tabs, warnings }
  } catch (e) {
    return {
      ok: false,
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

/** GET /api/dwd-preview/table-page：查看 DWD 主表/明细分页 */
export async function fetchDwdPreviewTablePage(params: {
  batchId: string
  /** 空字符串表示该批次下全部会话 */
  sessionId: string
  /** DWD 物理表名（更符合 DWD 预览语义）；指定时优先于 layer / tableType */
  dwdTable?: string
  /** 兼容旧参数：按 ODS table_type 解析到 DWD 表，并按 source_parquet_file 血缘过滤 */
  tableType?: string
  layer?: 'header' | 'detail'
  limit?: number
  cursor?: Record<string, unknown> | null
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  columns?: OdsPreviewColumn[]
  rows?: Array<Record<string, string>>
  has_more?: boolean
  next_cursor?: Record<string, unknown> | null
  limit?: number
  total_rows?: number | null
  error?: { message?: string; detail?: string }
}> {
  const { batchId, sessionId, dwdTable, tableType, layer = 'detail', limit = 200, cursor, signal } = params
  const q = new URLSearchParams({
    batch_id: batchId,
    session_id: sessionId,
    layer,
    limit: String(Math.max(1, Math.min(500, Math.floor(limit)))),
  })
  const dt = (dwdTable ?? '').trim()
  if (dt) q.set('dwd_table', dt)
  const tt = (tableType ?? '').trim()
  if (tt) q.set('table_type', tt)
  if (cursor && typeof cursor === 'object') {
    q.set('cursor', JSON.stringify(cursor))
  }
  try {
    const res = await apiFetch(`/api/dwd-preview/table-page?${q}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const cols = Array.isArray(json.columns) ? json.columns : []
    const columns: OdsPreviewColumn[] = cols
      .map((c: any) => ({
        field: String(c?.field ?? ''),
        label_zh: String(c?.label_zh ?? c?.labelZh ?? '').trim(),
      }))
      .filter((c: OdsPreviewColumn) => c.field.length > 0)
    const rowsRaw = Array.isArray(json.rows) ? json.rows : []
    const rows = _normalizeDwdPreviewRows(
      _normalizeOdsPreviewRows(rowsRaw as Array<Record<string, unknown>>),
    )
    const next_cursor =
      json.next_cursor != null && typeof json.next_cursor === 'object' && !Array.isArray(json.next_cursor)
        ? (json.next_cursor as Record<string, unknown>)
        : null
    return {
      ok: true,
      columns,
      rows,
      has_more: Boolean(json.has_more),
      next_cursor,
      limit: json.limit != null ? Number(json.limit) : undefined,
      total_rows: json.total_rows != null ? Number(json.total_rows) : null,
    }
  } catch (e) {
    return {
      ok: false,
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

/** POST /api/dwd-preview/delete：仅删除 DWD 落库行并重置 DWD 水位（不删 ODS） */
export async function deleteDwdPreviewLoad(body: {
  scope: 'session' | 'batch'
  batch_id: string
  session_id?: string
}): Promise<{
  ok: boolean
  deleted_header_rows?: number
  deleted_detail_rows?: number
  deleted_rows_by_table?: Record<string, number>
  ods_sessions_reset?: number
  error?: { message?: string; detail?: string; code?: string }
}> {
  try {
    const res = await apiFetch('/api/dwd-preview/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) {
      return {
        ok: false,
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    return {
      ok: true,
      deleted_header_rows:
        json.deleted_header_rows != null ? Number(json.deleted_header_rows) : undefined,
      deleted_detail_rows:
        json.deleted_detail_rows != null ? Number(json.deleted_detail_rows) : undefined,
      deleted_rows_by_table:
        json.deleted_rows_by_table && typeof json.deleted_rows_by_table === 'object'
          ? Object.fromEntries(
              Object.entries(json.deleted_rows_by_table as Record<string, unknown>).map(([k, v]) => [
                k,
                Number(v ?? 0),
              ]),
            )
          : undefined,
      ods_sessions_reset:
        json.ods_sessions_reset != null ? Number(json.ods_sessions_reset) : undefined,
    }
  } catch (e) {
    return {
      ok: false,
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

/** 删除 ODS 已导入数据：按会话或整批次（与本地 DuckDB / Parquet 一致） */
export async function deleteOdsPreviewImport(body: {
  scope: 'session' | 'batch'
  batch_id: string
  session_id?: string
}): Promise<{
  ok: boolean
  removed_paths?: string[]
  skipped_paths?: string[]
  error?: { message?: string; detail?: string }
}> {
  try {
    const res = await apiFetch('/api/ods-preview/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) {
      return {
        ok: false,
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    return {
      ok: true,
      removed_paths: Array.isArray(json.removed_paths)
        ? json.removed_paths.map((x: unknown) => String(x))
        : [],
      skipped_paths: Array.isArray(json.skipped_paths)
        ? json.skipped_paths.map((x: unknown) => String(x))
        : [],
    }
  } catch (e) {
    return {
      ok: false,
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export type HealthIndicatorDirection = {
  code: string
  title: string
  detail: string
  related_audit_topics: string[]
}

export type HealthIndicatorRow = {
  indicator_code: string
  indicator_name: string
  dimension_code: string
  dimension_name: string
  indicator_value: number
  score: number
  level: 'normal' | 'warning' | 'alert'
  weight_in_dimension: number
  weight_global: number
  formula_text: string
  threshold_text: string
  data_source_text: string
  hit_band_min: number | null
  hit_band_max: number | null
  suspicion_directions: HealthIndicatorDirection[]
  suggest_actions: string[]
  evidence_count: number
  explain_text: string
}

export type HealthScoreSnapshot = {
  ok: boolean
  rule_version?: string
  data_source?: string
  stat_year?: string
  entity_id?: string
  entity_name?: string
  overview?: {
    total_score: number
    grade: string
    risk_level?: string
    change_vs_prev: number
    score_formula: string
    grade_rule: string
  }
  flag_breakdown?: Array<{
    rule_id: string
    risk_level: string
    count: number
    amount: number
  }>
  dimensions?: Array<{
    dimension_code: string
    dimension_name: string
    weight: number
    score: number
  }>
  indicators?: HealthIndicatorRow[]
  top_deductions?: Array<{
    indicator_code: string
    indicator_name: string
    dimension_name: string
    score: number
    level: string
    explain_text: string
  }>
  error?: { message?: string; detail?: string }
}

export async function fetchHealthScoreSnapshot(params?: {
  batchId?: string
  sessionId?: string
  statYear?: string
  entityId?: string
  signal?: AbortSignal
}): Promise<HealthScoreSnapshot> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.sessionId) q.set('session_id', params.sessionId)
  if (params?.statYear) q.set('stat_year', params.statYear)
  if (params?.entityId) q.set('entity_id', params.entityId)
  try {
    const res = await apiFetch(`/api/quality/health-score?${q.toString()}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      rule_version: json.rule_version != null ? String(json.rule_version) : undefined,
      data_source: json.data_source != null ? String(json.data_source) : undefined,
      stat_year: json.stat_year != null ? String(json.stat_year) : undefined,
      entity_id: json.entity_id != null ? String(json.entity_id) : undefined,
      entity_name: json.entity_name != null ? String(json.entity_name) : undefined,
      overview: json.overview,
      dimensions: Array.isArray(json.dimensions) ? json.dimensions : [],
      indicators: Array.isArray(json.indicators) ? json.indicators : [],
      top_deductions: Array.isArray(json.top_deductions) ? json.top_deductions : [],
      flag_breakdown: Array.isArray(json.flag_breakdown) ? json.flag_breakdown : undefined,
    }
  } catch (e) {
    return {
      ok: false,
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export type RedInvoiceQualityOverview = {
  ok: boolean
  red_invoice_count: number
  unmatched_blue_count: number
  orphan_red_count: number
  matched_blue_count: number
  error?: { message?: string; detail?: string }
}

export async function fetchRedInvoiceQualityOverview(params?: {
  batchId?: string
  sessionId?: string
  signal?: AbortSignal
}): Promise<RedInvoiceQualityOverview> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.sessionId) q.set('session_id', params.sessionId)
  try {
    const res = await apiFetch(`/api/quality/red-invoice-overview?${q.toString()}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        red_invoice_count: 0,
        unmatched_blue_count: 0,
        orphan_red_count: 0,
        matched_blue_count: 0,
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    return {
      ok: true,
      red_invoice_count: Number(json.red_invoice_count ?? 0),
      unmatched_blue_count: Number(json.unmatched_blue_count ?? 0),
      orphan_red_count: Number(json.orphan_red_count ?? 0),
      matched_blue_count: Number(json.matched_blue_count ?? 0),
    }
  } catch (e) {
    return {
      ok: false,
      red_invoice_count: 0,
      unmatched_blue_count: 0,
      orphan_red_count: 0,
      matched_blue_count: 0,
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export type RedInvoiceQualityDetailRow = {
  header_uuid: string
  import_batch_id: string
  import_session_id: string
  sdfphm: string
  fpdm: string
  fphm: string
  jshj: number
  net_calc_status: string
  is_orphan_red: boolean
  related_blue_invoice_uuid: string
  bz: string
  quality_reason: string
}

export async function fetchRedInvoiceQualityDetails(params?: {
  batchId?: string
  sessionId?: string
  onlyUnmatched?: boolean
  limit?: number
  signal?: AbortSignal
}): Promise<{ ok: boolean; rows: RedInvoiceQualityDetailRow[]; error?: { message?: string; detail?: string } }> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.sessionId) q.set('session_id', params.sessionId)
  q.set('only_unmatched', params?.onlyUnmatched === false ? '0' : '1')
  q.set('limit', String(Math.max(1, Math.min(1000, Math.floor(params?.limit ?? 200)))))
  try {
    const res = await apiFetch(`/api/quality/red-invoice-details?${q.toString()}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, rows: [], error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const raw = Array.isArray(json.rows) ? json.rows : []
    return {
      ok: true,
      rows: raw.map((r: any) => ({
        header_uuid: String(r?.header_uuid ?? ''),
        import_batch_id: String(r?.import_batch_id ?? ''),
        import_session_id: String(r?.import_session_id ?? ''),
        sdfphm: String(r?.sdfphm ?? ''),
        fpdm: String(r?.fpdm ?? ''),
        fphm: String(r?.fphm ?? ''),
        jshj: Number(r?.jshj ?? 0),
        net_calc_status: String(r?.net_calc_status ?? ''),
        is_orphan_red: Boolean(r?.is_orphan_red),
        related_blue_invoice_uuid: String(r?.related_blue_invoice_uuid ?? ''),
        bz: String(r?.bz ?? ''),
        quality_reason: String(r?.quality_reason ?? ''),
      })),
    }
  } catch (e) {
    return { ok: false, rows: [], error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type RedInvoiceQualityTrendRow = {
  period_label: string
  period_start: string | null
  red_invoice_count: number
  unmatched_count: number
  orphan_count: number
  matched_count: number
}

export type RedInvoiceQualityTrend = {
  ok: boolean
  granularity: 'week' | 'month'
  rows: RedInvoiceQualityTrendRow[]
  error?: { message?: string; detail?: string }
}

export async function fetchRedInvoiceQualityTrend(params?: {
  batchId?: string
  sessionId?: string
  statYear?: string | number
  granularity?: 'week' | 'month'
  limit?: number
  signal?: AbortSignal
}): Promise<RedInvoiceQualityTrend> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.sessionId) q.set('session_id', params.sessionId)
  if (params?.statYear != null && String(params.statYear).trim()) q.set('stat_year', String(params.statYear).trim())
  q.set('granularity', params?.granularity === 'month' ? 'month' : 'week')
  q.set('limit', String(Math.max(1, Math.min(52, Math.floor(params?.limit ?? 12)))))
  try {
    const res = await apiFetch(`/api/quality/red-invoice-trend?${q.toString()}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        granularity: params?.granularity === 'month' ? 'month' : 'week',
        rows: [],
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    const gran = String(json.granularity ?? 'week') === 'month' ? 'month' : 'week'
    const raw = Array.isArray(json.rows) ? json.rows : []
    return {
      ok: true,
      granularity: gran,
      rows: raw.map((r: any) => ({
        period_label: String(r?.period_label ?? ''),
        period_start: r?.period_start != null ? String(r.period_start) : null,
        red_invoice_count: Number(r?.red_invoice_count ?? 0),
        unmatched_count: Number(r?.unmatched_count ?? 0),
        orphan_count: Number(r?.orphan_count ?? 0),
        matched_count: Number(r?.matched_count ?? 0),
      })),
    }
  } catch (e) {
    return {
      ok: false,
      granularity: params?.granularity === 'month' ? 'month' : 'week',
      rows: [],
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export type QualityImportBatch = {
  batch_id: string
  header_count: number
  last_build_time: string
}

export async function fetchQualityImportBatches(params?: {
  limit?: number
  signal?: AbortSignal
}): Promise<{ ok: boolean; batches: QualityImportBatch[]; error?: { message?: string; detail?: string } }> {
  const lim = Math.max(1, Math.min(200, Math.floor(params?.limit ?? 80)))
  try {
    const res = await apiFetch(`/api/quality/batches?limit=${lim}`, { signal: params?.signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, batches: [], error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const raw = Array.isArray(json.batches) ? json.batches : []
    return {
      ok: true,
      batches: raw.map((r: any) => ({
        batch_id: String(r?.batch_id ?? ''),
        header_count: Number(r?.header_count ?? 0),
        last_build_time: String(r?.last_build_time ?? ''),
      })),
    }
  } catch (e) {
    return { ok: false, batches: [], error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type StructuredDqTrendRow = {
  period_label: string
  period_start: string | null
  anomaly_count: number
  header_count?: number
  block_count?: number
}

export async function fetchDomainQualityTrend(params: {
  domain: 'uniqueness' | 'tax_id' | 'cross_table' | 'header_detail'
  batchId?: string
  sessionId?: string
  granularity?: 'week' | 'month'
  limit?: number
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  domain?: string
  granularity?: 'week' | 'month'
  rows?: StructuredDqTrendRow[]
  error?: { message?: string }
}> {
  const q = new URLSearchParams()
  q.set('domain', params.domain)
  if (params.batchId) q.set('batch_id', params.batchId)
  if (params.sessionId) q.set('session_id', params.sessionId)
  q.set('granularity', params.granularity === 'month' ? 'month' : 'week')
  q.set('limit', String(Math.max(1, Math.min(52, Math.floor(params.limit ?? 12)))))
  try {
    const res = await apiFetch(`/api/quality/domain-trend?${q.toString()}`, { signal: params.signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const rows: StructuredDqTrendRow[] = Array.isArray(json.rows)
      ? json.rows.map((r: any) => ({
          period_label: String(r?.period_label ?? ''),
          period_start: r?.period_start != null ? String(r.period_start) : null,
          anomaly_count: Number(r?.anomaly_count ?? 0),
          header_count: r?.header_count != null ? Number(r.header_count) : undefined,
          block_count: r?.block_count != null ? Number(r.block_count) : undefined,
        }))
      : []
    return {
      ok: true,
      domain: String(json.domain ?? params.domain),
      granularity: String(json.granularity ?? 'week') === 'month' ? 'month' : 'week',
      rows,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type QualityDomainKey =
  | 'uniqueness'
  | 'tax_id'
  | 'cross_table'
  | 'header_detail'
  | 'semantic'
  | 'red_link'
  | 'lineage_reject'
  | 'dwd_lineage'

export type LineageRejectQualityTrendRow = {
  period_label: string
  period_start: string | null
  row_reject_count: number
  file_blocking_count: number
  import_file_count: number
}

export type LineageRejectQualityTrend = {
  ok: boolean
  granularity: 'week' | 'month'
  rows: LineageRejectQualityTrendRow[]
  error?: { message?: string; detail?: string; code?: string }
}

export async function fetchLineageRejectQualityTrend(params?: {
  batchId?: string
  sessionId?: string
  granularity?: 'week' | 'month'
  limit?: number
  signal?: AbortSignal
}): Promise<LineageRejectQualityTrend> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.sessionId) q.set('session_id', params.sessionId)
  q.set('granularity', params?.granularity === 'month' ? 'month' : 'week')
  q.set('limit', String(Math.max(1, Math.min(52, Math.floor(params?.limit ?? 12)))))
  try {
    const res = await apiFetch(`/api/quality/lineage-reject-trend?${q.toString()}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        granularity: params?.granularity === 'month' ? 'month' : 'week',
        rows: [],
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    const gran = String(json.granularity ?? 'week') === 'month' ? 'month' : 'week'
    const raw = Array.isArray(json.rows) ? json.rows : []
    return {
      ok: true,
      granularity: gran,
      rows: raw.map((r: any) => ({
        period_label: String(r?.period_label ?? ''),
        period_start: r?.period_start != null ? String(r.period_start) : null,
        row_reject_count: Number(r?.row_reject_count ?? 0),
        file_blocking_count: Number(r?.file_blocking_count ?? 0),
        import_file_count: Number(r?.import_file_count ?? 0),
      })),
    }
  } catch (e) {
    return {
      ok: false,
      granularity: params?.granularity === 'month' ? 'month' : 'week',
      rows: [],
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export type DwdLineageQualityTrendRow = {
  period_label: string
  period_start: string | null
  header_count: number
  missing_header_count: number
  missing_detail_count: number
  coverage_rate: number
}

export type DwdLineageQualityTrend = {
  ok: boolean
  granularity: 'week' | 'month'
  time_basis?: string
  rows: DwdLineageQualityTrendRow[]
  error?: { message?: string; detail?: string; code?: string }
}

export async function fetchDwdLineageQualityTrend(params?: {
  batchId?: string
  sessionId?: string
  granularity?: 'week' | 'month'
  limit?: number
  signal?: AbortSignal
}): Promise<DwdLineageQualityTrend> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.sessionId) q.set('session_id', params.sessionId)
  q.set('granularity', params?.granularity === 'month' ? 'month' : 'week')
  q.set('limit', String(Math.max(1, Math.min(52, Math.floor(params?.limit ?? 12)))))
  try {
    const res = await apiFetch(`/api/quality/dwd-lineage-trend?${q.toString()}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        granularity: params?.granularity === 'month' ? 'month' : 'week',
        rows: [],
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    const gran = String(json.granularity ?? 'week') === 'month' ? 'month' : 'week'
    const raw = Array.isArray(json.rows) ? json.rows : []
    return {
      ok: true,
      granularity: gran,
      time_basis: json.time_basis != null ? String(json.time_basis) : undefined,
      rows: raw.map((r: any) => ({
        period_label: String(r?.period_label ?? ''),
        period_start: r?.period_start != null ? String(r.period_start) : null,
        header_count: Number(r?.header_count ?? 0),
        missing_header_count: Number(r?.missing_header_count ?? 0),
        missing_detail_count: Number(r?.missing_detail_count ?? 0),
        coverage_rate: Number(r?.coverage_rate ?? 0),
      })),
    }
  } catch (e) {
    return {
      ok: false,
      granularity: params?.granularity === 'month' ? 'month' : 'week',
      rows: [],
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export type SemanticQualityTrendRow = {
  period_label: string
  period_start: string | null
  missing_spc_tickets: number
  summary_line_count: number
}

export type SemanticQualityTrend = {
  ok: boolean
  granularity: 'week' | 'month'
  time_basis?: string
  rows: SemanticQualityTrendRow[]
  error?: { message?: string; detail?: string; code?: string }
}

export async function fetchSemanticQualityTrend(params?: {
  batchId?: string
  sessionId?: string
  granularity?: 'week' | 'month'
  limit?: number
  signal?: AbortSignal
}): Promise<SemanticQualityTrend> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.sessionId) q.set('session_id', params.sessionId)
  q.set('granularity', params?.granularity === 'month' ? 'month' : 'week')
  q.set('limit', String(Math.max(1, Math.min(52, Math.floor(params?.limit ?? 12)))))
  try {
    const res = await apiFetch(`/api/quality/semantic-trend?${q.toString()}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        granularity: params?.granularity === 'month' ? 'month' : 'week',
        rows: [],
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    const gran = String(json.granularity ?? 'week') === 'month' ? 'month' : 'week'
    const raw = Array.isArray(json.rows) ? json.rows : []
    return {
      ok: true,
      granularity: gran,
      time_basis: json.time_basis != null ? String(json.time_basis) : undefined,
      rows: raw.map((r: any) => ({
        period_label: String(r?.period_label ?? ''),
        period_start: r?.period_start != null ? String(r.period_start) : null,
        missing_spc_tickets: Number(r?.missing_spc_tickets ?? 0),
        summary_line_count: Number(r?.summary_line_count ?? 0),
      })),
    }
  } catch (e) {
    return {
      ok: false,
      granularity: params?.granularity === 'month' ? 'month' : 'week',
      rows: [],
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export type SemanticQualitySyncFlagsResult = {
  ok: boolean
  batch_id?: string | null
  stat_year?: number | null
  analysis_batch?: string
  finding_count?: number
  inserted?: number
  updated?: number
  skipped_confirmed?: number
  by_rule?: Record<string, number>
  error?: { message?: string; detail?: string }
}

export async function postSemanticQualitySyncFlags(params?: {
  batchId?: string
  statYear?: number
  signal?: AbortSignal
}): Promise<SemanticQualitySyncFlagsResult> {
  try {
    const res = await apiFetch('/api/quality/semantic/sync-flags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch_id: params?.batchId,
        stat_year: params?.statYear,
      }),
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as SemanticQualitySyncFlagsResult
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return json
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type TaxCodeSyncFlagsResult = {
  ok: boolean
  stat_year?: number
  entity_id?: string | null
  analysis_batch?: string
  finding_count?: number
  inserted?: number
  updated?: number
  skipped_confirmed?: number
  by_rule?: Record<string, number>
  min_line_count?: number
  min_high_risk_amount?: number
  error?: { message?: string; detail?: string }
}

export async function postTaxCodeSyncFlags(params: {
  statYear: string
  entityId?: string
  minLineCount?: number
  minHighRiskAmount?: number
  signal?: AbortSignal
}): Promise<TaxCodeSyncFlagsResult> {
  try {
    const res = await apiFetch('/api/dim/tax-code/analysis/sync-flags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stat_year: params.statYear,
        entity_id: params.entityId,
        min_line_count: params.minLineCount,
        min_high_risk_amount: params.minHighRiskAmount,
      }),
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as TaxCodeSyncFlagsResult
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return json
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DqDomainDetailRow = {
  ticket_key: string
  header_uuid: string
  domain: QualityDomainKey
  rule_id: string
  severity: 'block' | 'warn' | 'info'
  summary: string
  import_batch_id: string
  import_session_id: string
  delta_value: number | null
  extra?: Record<string, unknown>
}

export async function fetchDqDomainDetails(params: {
  domain: QualityDomainKey
  batchId?: string
  sessionId?: string
  onlyUnmatched?: boolean
  limit?: number
  offset?: number
  ticketKey?: string
  sourceExcelFile?: string
  sourceSheet?: string
  rowKind?: 'all' | 'header' | 'detail'
  onlyMissing?: boolean
  ruleId?: string
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  domain?: QualityDomainKey
  rows: DqDomainDetailRow[]
  limit?: number
  offset?: number
  total_count?: number
  error?: { message?: string; detail?: string }
}> {
  const q = new URLSearchParams()
  q.set('domain', params.domain)
  if (params.batchId) q.set('batch_id', params.batchId)
  if (params.sessionId) q.set('session_id', params.sessionId)
  if (params.onlyUnmatched === false) q.set('only_unmatched', '0')
  if (params.limit != null) q.set('limit', String(params.limit))
  if (params.offset != null) q.set('offset', String(params.offset))
  if (params.ticketKey?.trim()) q.set('ticket_key', params.ticketKey.trim())
  if (params.sourceExcelFile?.trim()) q.set('source_excel_file', params.sourceExcelFile.trim())
  if (params.sourceSheet?.trim()) q.set('source_sheet', params.sourceSheet.trim())
  if (params.rowKind && params.rowKind !== 'all') q.set('row_kind', params.rowKind)
  if (params.onlyMissing) q.set('only_missing', '1')
  if (params.ruleId?.trim()) q.set('rule_id', params.ruleId.trim())
  try {
    const res = await apiFetch(`/api/quality/domain-details?${q.toString()}`, {
      signal: params.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, rows: [], error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const raw = Array.isArray(json.rows) ? json.rows : []
    return {
      ok: true,
      domain: String(json.domain ?? params.domain) as QualityDomainKey,
      limit: Number(json.limit ?? params.limit ?? 200),
      offset: Number(json.offset ?? params.offset ?? 0),
      total_count: json.total_count != null ? Number(json.total_count) : undefined,
      rows: raw.map((r: any) => ({
        ticket_key: String(r?.ticket_key ?? ''),
        header_uuid: String(r?.header_uuid ?? ''),
        domain: String(r?.domain ?? params.domain) as QualityDomainKey,
        rule_id: String(r?.rule_id ?? ''),
        severity: (['block', 'warn', 'info'].includes(String(r?.severity))
          ? String(r.severity)
          : 'warn') as DqDomainDetailRow['severity'],
        summary: String(r?.summary ?? ''),
        import_batch_id: String(r?.import_batch_id ?? ''),
        import_session_id: String(r?.import_session_id ?? ''),
        delta_value: r?.delta_value == null ? null : Number(r.delta_value),
        extra: r?.extra && typeof r.extra === 'object' ? r.extra : undefined,
      })),
    }
  } catch (e) {
    return { ok: false, rows: [], error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DqDomainOverview = {
  ok: boolean
  import_field_mapping_template?: {
    template_id: string
    template_name: string
    template_updated_at?: string
  } | null
  kpi: {
    scanned_headers: number
    anomaly_headers: number
    block_count: number
    warn_count: number
    info_count: number
  }
  domains: {
    uniqueness: { dup_groups: number; dup_tickets: number }
    tax_id: { empty_count: number; bad_len_count: number }
    cross_table: { linecount_mismatch_tickets: number; uuid_mismatch_rows: number }
    header_detail: { unbalanced_count: number; max_balance_delta: number | null }
    semantic: { missing_spc_tickets: number; summary_line_count: number }
    red_link: {
      unmatched_blue_count: number
      orphan_red_count: number
      matched_blue_count: number
      red_invoice_count: number
    }
    lineage_reject: {
      row_reject_count: number
      file_blocking_count: number
      reject_sample_count: number
      import_file_count: number
    }
    dwd_lineage: {
      missing_header_count: number
      missing_detail_count: number
      distinct_source_files: number
      coverage_rate: number
    }
  }
  dup_counts: {
    header_groups: number
    detail_groups: number
    spc_groups: number | null
  }
  gaps?: string[]
  error?: { message?: string; detail?: string }
}

export async function fetchDqDomainOverview(params?: {
  batchId?: string
  sessionId?: string
  signal?: AbortSignal
}): Promise<DqDomainOverview> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.sessionId) q.set('session_id', params.sessionId)
  const empty: DqDomainOverview = {
    ok: false,
    kpi: { scanned_headers: 0, anomaly_headers: 0, block_count: 0, warn_count: 0, info_count: 0 },
    domains: {
      uniqueness: { dup_groups: 0, dup_tickets: 0 },
      tax_id: { empty_count: 0, bad_len_count: 0 },
      cross_table: { linecount_mismatch_tickets: 0, uuid_mismatch_rows: 0 },
      header_detail: { unbalanced_count: 0, max_balance_delta: null },
      semantic: { missing_spc_tickets: 0, summary_line_count: 0 },
      red_link: {
        unmatched_blue_count: 0,
        orphan_red_count: 0,
        matched_blue_count: 0,
        red_invoice_count: 0,
      },
      lineage_reject: {
        row_reject_count: 0,
        file_blocking_count: 0,
        reject_sample_count: 0,
        import_file_count: 0,
      },
      dwd_lineage: {
        missing_header_count: 0,
        missing_detail_count: 0,
        distinct_source_files: 0,
        coverage_rate: 100,
      },
    },
    dup_counts: { header_groups: 0, detail_groups: 0, spc_groups: null },
  }
  try {
    const res = await apiFetch(`/api/quality/domain-overview?${q.toString()}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ...empty, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const kpi = json.kpi ?? {}
    const dom = json.domains ?? {}
    const dup = json.dup_counts ?? {}
    const rawTpl = json.import_field_mapping_template
    const import_field_mapping_template =
      rawTpl && typeof rawTpl === 'object' && String(rawTpl.template_id ?? '').trim()
        ? {
            template_id: String(rawTpl.template_id ?? ''),
            template_name: String(rawTpl.template_name ?? rawTpl.template_id ?? ''),
            template_updated_at: String(rawTpl.template_updated_at ?? '').trim() || undefined,
          }
        : null
    return {
      ok: true,
      import_field_mapping_template,
      kpi: {
        scanned_headers: Number(kpi.scanned_headers ?? 0),
        anomaly_headers: Number(kpi.anomaly_headers ?? 0),
        block_count: Number(kpi.block_count ?? 0),
        warn_count: Number(kpi.warn_count ?? 0),
        info_count: Number(kpi.info_count ?? 0),
      },
      domains: {
        uniqueness: {
          dup_groups: Number(dom.uniqueness?.dup_groups ?? 0),
          dup_tickets: Number(dom.uniqueness?.dup_tickets ?? 0),
        },
        tax_id: {
          empty_count: Number(dom.tax_id?.empty_count ?? 0),
          bad_len_count: Number(dom.tax_id?.bad_len_count ?? 0),
        },
        cross_table: {
          linecount_mismatch_tickets: Number(dom.cross_table?.linecount_mismatch_tickets ?? 0),
          uuid_mismatch_rows: Number(dom.cross_table?.uuid_mismatch_rows ?? 0),
        },
        header_detail: {
          unbalanced_count: Number(dom.header_detail?.unbalanced_count ?? 0),
          max_balance_delta:
            dom.header_detail?.max_balance_delta == null
              ? null
              : Number(dom.header_detail.max_balance_delta),
        },
        semantic: {
          missing_spc_tickets: Number(dom.semantic?.missing_spc_tickets ?? 0),
          summary_line_count: Number(dom.semantic?.summary_line_count ?? 0),
        },
        red_link: {
          unmatched_blue_count: Number(dom.red_link?.unmatched_blue_count ?? 0),
          orphan_red_count: Number(dom.red_link?.orphan_red_count ?? 0),
          matched_blue_count: Number(dom.red_link?.matched_blue_count ?? 0),
          red_invoice_count: Number(dom.red_link?.red_invoice_count ?? 0),
        },
        lineage_reject: {
          row_reject_count: Number(dom.lineage_reject?.row_reject_count ?? 0),
          file_blocking_count: Number(dom.lineage_reject?.file_blocking_count ?? 0),
          reject_sample_count: Number(dom.lineage_reject?.reject_sample_count ?? 0),
          import_file_count: Number(dom.lineage_reject?.import_file_count ?? 0),
        },
        dwd_lineage: {
          missing_header_count: Number(dom.dwd_lineage?.missing_header_count ?? 0),
          missing_detail_count: Number(dom.dwd_lineage?.missing_detail_count ?? 0),
          distinct_source_files: Number(dom.dwd_lineage?.distinct_source_files ?? 0),
          coverage_rate: Number(dom.dwd_lineage?.coverage_rate ?? 0),
        },
      },
      dup_counts: {
        header_groups: Number(dup.header_groups ?? 0),
        detail_groups: Number(dup.detail_groups ?? 0),
        spc_groups: dup.spc_groups == null ? null : Number(dup.spc_groups),
      },
      gaps: Array.isArray(json.gaps) ? json.gaps.map(String) : undefined,
    }
  } catch (e) {
    return { ...empty, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function parseRedInvoiceBzDebug(params: {
  bz: string
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  matched: boolean
  rule_name?: string | null
  mode?: string | null
  pattern?: string | null
  groups?: string[]
  matched_text?: string | null
  target_blue_header_uuid?: string | null
  error?: { message?: string; detail?: string }
}> {
  try {
    const res = await apiFetch('/api/quality/red-invoice-parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ bz: params.bz }),
      signal: params.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json) {
      return {
        ok: false,
        matched: false,
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    return {
      ok: Boolean(json.ok),
      matched: Boolean(json.matched),
      rule_name: json.rule_name != null ? String(json.rule_name) : null,
      mode: json.mode != null ? String(json.mode) : null,
      pattern: json.pattern != null ? String(json.pattern) : null,
      groups: Array.isArray(json.groups) ? json.groups.map((x: unknown) => String(x ?? '')) : [],
      matched_text: json.matched_text != null ? String(json.matched_text) : null,
      target_blue_header_uuid:
        json.target_blue_header_uuid != null ? String(json.target_blue_header_uuid) : null,
      error: json.error,
    }
  } catch (e) {
    return {
      ok: false,
      matched: false,
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export type DimTaxCodeImportResult = {
  ok: boolean
  implemented?: boolean
  dry_run?: boolean
  message?: string
  received?: Record<string, unknown>
  stats?: Record<string, unknown>
  error?: { message?: string }
}

/**
 * 税收分类编码维表导入：multipart 带 `file` 时走 DuckDB 落库（`source_path` 可传空字符串）；
 * 无 `file` 时须传 `source_path` 由服务端按仓库相对路径读取；仅 JSON 时多为 dry_run/参数校验。
 * 对应 `POST /api/dim-tax-code/import`。
 */
export async function postDimTaxCodeImport(params: {
  data_version: string
  source_path: string
  strategy: string
  file?: File | null
  signal?: AbortSignal
}): Promise<DimTaxCodeImportResult> {
  try {
    let res: Response
    if (params.file) {
      const fd = new FormData()
      fd.append('data_version', params.data_version)
      fd.append('source_path', params.source_path)
      fd.append('strategy', params.strategy)
      fd.append('file', params.file)
      res = await apiFetch('/api/dim-tax-code/import', {
        method: 'POST',
        body: fd,
        signal: params.signal,
      })
    } else {
      res = await apiFetch('/api/dim-tax-code/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          data_version: params.data_version,
          source_path: params.source_path,
          strategy: params.strategy,
        }),
        signal: params.signal,
      })
    }
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok) {
      return {
        ok: false,
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    return {
      ok: Boolean(json.ok),
      implemented: json.implemented != null ? Boolean(json.implemented) : undefined,
      dry_run: json.dry_run != null ? Boolean(json.dry_run) : undefined,
      message: json.message != null ? String(json.message) : undefined,
      received: json.received && typeof json.received === 'object' ? (json.received as Record<string, unknown>) : undefined,
      stats: json.stats && typeof json.stats === 'object' ? (json.stats as Record<string, unknown>) : undefined,
      error: json.error,
    }
  } catch (e) {
    return {
      ok: false,
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export type DimTaxCodeRowDto = {
  taxCode: string
  goodsName: string
  goodsShortName: string
  description: string
  parentCode: string | null
  levelDepth: number
  isLeaf: boolean
  fullPath: string
  cleanStatus: string
  auditRiskLabel: string
  dataVersion: string
  importBatchId: string
  importSessionId: string
  sourceSheet: string
  sourceExcelFile: string
}

export async function fetchDimTaxCodeRows(params: {
  keyword?: string
  cleanStatus?: string
  risk?: string
  importBatchId?: string
  importSessionId?: string
  abnormalOnly?: boolean
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  total: number
  rows: DimTaxCodeRowDto[]
  error?: { message?: string }
}> {
  try {
    const sp = new URLSearchParams()
    if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
    sp.set('clean_status', params.cleanStatus ?? 'all')
    sp.set('risk', params.risk ?? 'all')
    if (params.importBatchId?.trim()) sp.set('import_batch_id', params.importBatchId.trim())
    if (params.importSessionId?.trim()) sp.set('import_session_id', params.importSessionId.trim())
    if (params.abnormalOnly) sp.set('abnormal_only', '1')
    const res = await apiFetch(`/api/dim-tax-code/rows?${sp.toString()}`, { signal: params.signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        total: 0,
        rows: [],
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    const rows = Array.isArray(json.rows) ? (json.rows as DimTaxCodeRowDto[]) : []
    const total = Number(json.total)
    return { ok: true, total: Number.isFinite(total) ? total : rows.length, rows }
  } catch (e) {
    return {
      ok: false,
      total: 0,
      rows: [],
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export async function fetchDimTaxCodeFilterOptions(params?: {
  importBatchId?: string
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  importBatchOptions: string[]
  importSessionOptions: string[]
  error?: { message?: string }
}> {
  try {
    const sp = new URLSearchParams()
    if (params?.importBatchId?.trim()) sp.set('import_batch_id', params.importBatchId.trim())
    const qs = sp.toString()
    const res = await apiFetch(`/api/dim-tax-code/filter-options${qs ? `?${qs}` : ''}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        importBatchOptions: [],
        importSessionOptions: [],
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    return {
      ok: true,
      importBatchOptions: Array.isArray(json.importBatchOptions)
        ? json.importBatchOptions.map((v: unknown) => String(v))
        : [],
      importSessionOptions: Array.isArray(json.importSessionOptions)
        ? json.importSessionOptions.map((v: unknown) => String(v))
        : [],
    }
  } catch (e) {
    return {
      ok: false,
      importBatchOptions: [],
      importSessionOptions: [],
      error: { message: e instanceof Error ? e.message : '网络错误' },
    }
  }
}

export async function postDimTaxCodeReapplyRiskRules(signal?: AbortSignal): Promise<{
  ok: boolean
  message?: string
  stats?: Record<string, unknown>
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim-tax-code/reapply-risk-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: '{}',
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    return {
      ok: Boolean(json.ok),
      message: json.message != null ? String(json.message) : undefined,
      stats: json.stats && typeof json.stats === 'object' ? (json.stats as Record<string, unknown>) : undefined,
      error: json.error,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDimTaxCodeRiskRules(signal?: AbortSignal): Promise<{
  ok: boolean
  yamlText: string
  source?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim-tax-code/risk-rules', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    const msg = json?.error?.message != null ? String(json.error.message) : undefined
    const friendly =
      msg === 'Not Found'
        ? '本地 API 尚未加载“敏感类目定义”接口，请重启本地 API（dev.bat api 或重启 dev.bat all）后重试。'
        : msg
    return {
      ok: Boolean(json.ok),
      yamlText: json.yaml_text != null ? String(json.yaml_text) : '',
      source: json.source != null ? String(json.source) : undefined,
      error: friendly ? { message: friendly } : json.error,
    }
  } catch (e) {
    return { ok: false, yamlText: '', error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function saveDimTaxCodeRiskRules(
  yamlText: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message?: string; source?: string; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/dim-tax-code/risk-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ yaml_text: yamlText }),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    return {
      ok: Boolean(json.ok),
      message: json.message != null ? String(json.message) : undefined,
      source: json.source != null ? String(json.source) : undefined,
      error: json.error,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type TaxCodeFluctuation = {
  fluctuation_index: number | null
  fluctuation_level: 'low' | 'medium' | 'high' | null
  top_movers: Array<{
    category_prefix: string
    baseline_share: number
    compare_share: number
    delta_share: number
  }>
  baseline_month: number | null
  compare_month: number | null
  fluctuation_hint?: string | null
}

export type TaxCodeAnalysisOverview = {
  stat_year: string
  match_rate: number
  unmatched_line_count: number
  unmatched_amount: number
  high_risk_amount_share: number
  top_category_share: number
  top_category_name?: string | null
  stat_years?: string[]
  dim_tax_code_count?: number
  hint?: string | null
  caliber_hint?: string | null
} & Partial<TaxCodeFluctuation>

export type TaxCodeUnmatchedRow = {
  ssflbm: string
  line_count: number
  amount_sum: number
  sample_invoice_count: number
}

export type TaxCodeEnterpriseRow = {
  entity_id: string
  entity_name: string
  taxpayer_id: string
  top_category: string
  top_category_ratio: number
  high_risk_ratio: number
  fluctuation_index: number | null
  total_amount?: number
  invoice_count?: number
}

export type TaxCodeEnterpriseSummary = {
  stat_year: string
  total: number
  rows: TaxCodeEnterpriseRow[]
  category_options?: string[]
  kpis?: {
    enterprise_coverage: number
    high_risk_enterprise_count: number
    top_category_concentration: number
    monthly_mutation_rate: number | null
  }
  stat_years?: string[]
  dim_tax_code_count?: number
  hint?: string | null
  fluctuation_hint?: string | null
  caliber_hint?: string | null
  min_invoice_count?: number
} & Partial<TaxCodeFluctuation>

export async function fetchTaxCodeAnalysisOverview(
  params: {
    statYear: string
    entityId?: string
    importBatchId?: string
    keyword?: string
    goodsName?: string
    slvNum?: string
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; aborted?: boolean; data?: TaxCodeAnalysisOverview; error?: { message?: string } }> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.entityId?.trim()) sp.set('entity_id', params.entityId.trim())
  if (params.importBatchId?.trim()) sp.set('import_batch_id', params.importBatchId.trim())
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  if (params.goodsName?.trim()) sp.set('goods_name', params.goodsName.trim())
  if (params.slvNum?.trim()) sp.set('slv_num', params.slvNum.trim())
  try {
    const res = await apiFetch(`/api/dim/tax-code/analysis/overview?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      data: {
        stat_year: String(json.stat_year ?? params.statYear),
        match_rate: Number(json.match_rate ?? 0),
        unmatched_line_count: Number(json.unmatched_line_count ?? 0),
        unmatched_amount: Number(json.unmatched_amount ?? 0),
        high_risk_amount_share: Number(json.high_risk_amount_share ?? 0),
        top_category_share: Number(json.top_category_share ?? 0),
        top_category_name: json.top_category_name != null ? String(json.top_category_name) : null,
        stat_years: Array.isArray(json.stat_years) ? json.stat_years.map(String) : undefined,
        dim_tax_code_count: Number(json.dim_tax_code_count ?? 0),
        hint: json.hint != null ? String(json.hint) : null,
        caliber_hint: json.caliber_hint != null ? String(json.caliber_hint) : null,
        fluctuation_index: json.fluctuation_index != null ? Number(json.fluctuation_index) : null,
        fluctuation_level:
          json.fluctuation_level === 'low' ||
          json.fluctuation_level === 'medium' ||
          json.fluctuation_level === 'high'
            ? json.fluctuation_level
            : null,
        baseline_month: json.baseline_month != null ? Number(json.baseline_month) : null,
        compare_month: json.compare_month != null ? Number(json.compare_month) : null,
        top_movers: Array.isArray(json.top_movers)
          ? json.top_movers.map((m: any) => ({
              category_prefix: String(m?.category_prefix ?? ''),
              baseline_share: Number(m?.baseline_share ?? 0),
              compare_share: Number(m?.compare_share ?? 0),
              delta_share: Number(m?.delta_share ?? 0),
            }))
          : [],
        fluctuation_hint: json.fluctuation_hint != null ? String(json.fluctuation_hint) : null,
      },
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchTaxCodeAnalysisUnmatched(
  params: {
    statYear: string
    entityId?: string
    importBatchId?: string
    keyword?: string
    goodsName?: string
    slvNum?: string
    page?: number
    pageSize?: number
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  total?: number
  rows?: TaxCodeUnmatchedRow[]
  hint?: string | null
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.entityId?.trim()) sp.set('entity_id', params.entityId.trim())
  if (params.importBatchId?.trim()) sp.set('import_batch_id', params.importBatchId.trim())
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  if (params.goodsName?.trim()) sp.set('goods_name', params.goodsName.trim())
  if (params.slvNum?.trim()) sp.set('slv_num', params.slvNum.trim())
  sp.set('page', String(params.page ?? 1))
  sp.set('page_size', String(params.pageSize ?? 50))
  try {
    const res = await apiFetch(`/api/dim/tax-code/analysis/unmatched?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const rows: TaxCodeUnmatchedRow[] = (json.rows ?? []).map((x: any) => ({
      ssflbm: String(x?.ssflbm ?? ''),
      line_count: Number(x?.line_count ?? 0),
      amount_sum: Number(x?.amount_sum ?? 0),
      sample_invoice_count: Number(x?.sample_invoice_count ?? 0),
    }))
    return {
      ok: true,
      total: Number(json.total ?? 0),
      rows,
      hint: json.hint != null ? String(json.hint) : null,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchTaxCodeEnterpriseSummary(
  params: {
    statYear: string
    entityId?: string
    keyword?: string
    topCategory?: string
    goodsName?: string
    slvNum?: string
    page?: number
    pageSize?: number
    minInvoiceCount?: number
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; aborted?: boolean; data?: TaxCodeEnterpriseSummary; error?: { message?: string } }> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.entityId?.trim()) sp.set('entity_id', params.entityId.trim())
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  if (params.topCategory?.trim() && params.topCategory !== 'all') {
    sp.set('top_category', params.topCategory.trim())
  }
  if (params.goodsName?.trim()) sp.set('goods_name', params.goodsName.trim())
  if (params.slvNum?.trim()) sp.set('slv_num', params.slvNum.trim())
  sp.set('page', String(params.page ?? 1))
  sp.set('page_size', String(params.pageSize ?? 50))
  if (params.minInvoiceCount != null && Number.isFinite(params.minInvoiceCount)) {
    sp.set('min_invoice_count', String(Math.trunc(params.minInvoiceCount)))
  }
  try {
    const res = await apiFetch(`/api/dim/tax-code/analysis/enterprise-summary?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const rows: TaxCodeEnterpriseRow[] = (json.rows ?? []).map((x: any) => ({
      entity_id: String(x?.entity_id ?? ''),
      entity_name: String(x?.entity_name ?? ''),
      taxpayer_id: String(x?.taxpayer_id ?? x?.entity_id ?? ''),
      top_category: String(x?.top_category ?? '—'),
      top_category_ratio: Number(x?.top_category_ratio ?? 0),
      high_risk_ratio: Number(x?.high_risk_ratio ?? 0),
      fluctuation_index: x?.fluctuation_index != null ? Number(x.fluctuation_index) : null,
      total_amount: Number(x?.total_amount ?? 0),
      invoice_count: Number(x?.invoice_count ?? 0),
    }))
    return {
      ok: true,
      data: {
        stat_year: String(json.stat_year ?? params.statYear),
        total: Number(json.total ?? 0),
        rows,
        category_options: Array.isArray(json.category_options) ? json.category_options.map(String) : [],
        kpis: json.kpis
          ? {
              enterprise_coverage: Number(json.kpis.enterprise_coverage ?? 0),
              high_risk_enterprise_count: Number(json.kpis.high_risk_enterprise_count ?? 0),
              top_category_concentration: Number(json.kpis.top_category_concentration ?? 0),
              monthly_mutation_rate:
                json.kpis.monthly_mutation_rate != null ? Number(json.kpis.monthly_mutation_rate) : null,
            }
          : undefined,
        stat_years: Array.isArray(json.stat_years) ? json.stat_years.map(String) : undefined,
        dim_tax_code_count: Number(json.dim_tax_code_count ?? 0),
        hint: json.hint != null ? String(json.hint) : null,
        fluctuation_hint: json.fluctuation_hint != null ? String(json.fluctuation_hint) : null,
        caliber_hint: json.caliber_hint != null ? String(json.caliber_hint) : null,
        min_invoice_count: Number(json.min_invoice_count ?? 10),
        fluctuation_index: json.fluctuation_index != null ? Number(json.fluctuation_index) : null,
        fluctuation_level:
          json.fluctuation_level === 'low' ||
          json.fluctuation_level === 'medium' ||
          json.fluctuation_level === 'high'
            ? json.fluctuation_level
            : null,
        baseline_month: json.baseline_month != null ? Number(json.baseline_month) : null,
        compare_month: json.compare_month != null ? Number(json.compare_month) : null,
        top_movers: Array.isArray(json.top_movers)
          ? json.top_movers.map((m: any) => ({
              category_prefix: String(m?.category_prefix ?? ''),
              baseline_share: Number(m?.baseline_share ?? 0),
              compare_share: Number(m?.compare_share ?? 0),
              delta_share: Number(m?.delta_share ?? 0),
            }))
          : [],
      },
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type SubjectCategoryRuleDto = {
  category_code: string
  category_name: string
  gb_code: string
  register_authority: string
  legal_form: string
  invoice_scene: string
  default_risk_focus: string
  coverage_count: number
  enabled: boolean
}

export async function fetchSubjectCategoryRules(signal?: AbortSignal): Promise<{
  ok: boolean
  source?: string
  standard_version?: string
  updated_at?: string
  categories: SubjectCategoryRuleDto[]
  error?: { message?: string }
}> {
  let lastError: { message?: string } | undefined
  for (const url of subjectCategoryApiCandidates()) {
    try {
      const res = await fetch(url, { signal })
      const json = (await res.json().catch(() => ({}))) as any
      if (!res.ok || !json?.ok) {
        lastError = json?.error ?? { message: `HTTP ${res.status}` }
        continue
      }
      const raw = Array.isArray(json.categories) ? json.categories : []
      const categories: SubjectCategoryRuleDto[] = raw.map((x: any) => ({
        category_code: String(x?.category_code ?? '').trim(),
        category_name: String(x?.category_name ?? '').trim(),
        gb_code: String(x?.gb_code ?? '').trim(),
        register_authority: String(x?.register_authority ?? '').trim(),
        legal_form: String(x?.legal_form ?? '').trim(),
        invoice_scene: String(x?.invoice_scene ?? '').trim(),
        default_risk_focus: String(x?.default_risk_focus ?? '').trim(),
        coverage_count: Number(x?.coverage_count ?? 0),
        enabled: Boolean(x?.enabled),
      }))
      return {
        ok: true,
        source: json.source != null ? String(json.source) : undefined,
        standard_version: json.standard_version != null ? String(json.standard_version) : undefined,
        updated_at: json.updated_at != null ? String(json.updated_at) : undefined,
        categories,
      }
    } catch (e) {
      lastError = { message: e instanceof Error ? e.message : '网络错误' }
    }
  }
  return { ok: false, categories: [], error: lastError ?? { message: '网络错误' } }
}

export async function saveSubjectCategoryRules(
  payload: { standard_version?: string; categories: SubjectCategoryRuleDto[] },
  signal?: AbortSignal,
): Promise<{ ok: boolean; message?: string; source?: string; error?: { message?: string } }> {
  const normalizeApiError = (err: any, status: number): { message: string } => {
    const msg = err?.message != null ? String(err.message) : `HTTP ${status}`
    const detail = err?.detail != null ? String(err.detail) : ''
    return { message: detail ? `${msg}：${detail}` : msg }
  }
  let lastError: { message?: string } | undefined
  for (const url of subjectCategoryApiCandidates()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal,
      })
      const json = (await res.json().catch(() => ({}))) as any
      if (!json?.ok) {
        lastError = normalizeApiError(json?.error, res.status)
        continue
      }
      return {
        ok: true,
        message: json.message != null ? String(json.message) : undefined,
        source: json.source != null ? String(json.source) : undefined,
      }
    } catch (e) {
      lastError = { message: e instanceof Error ? e.message : '网络错误' }
    }
  }
  return { ok: false, error: lastError ?? { message: '网络错误' } }
}

export type DimDictEntryDto = {
  code: string
  label: string
  sort_order: number
  enabled: boolean
  notes: string
}

export type DimDictDomainDto = {
  domain_id: string
  domain_name: string
  description: string
  source_table: string
  source_column: string
  built_in: boolean
  entries: DimDictEntryDto[]
}

export async function fetchDimDict(signal?: AbortSignal): Promise<{
  ok: boolean
  version?: number
  updated_at?: string
  domains: DimDictDomainDto[]
  store_path?: string
  hint?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim-dict', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, domains: [], error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const rawDomains = Array.isArray(json.domains) ? json.domains : []
    const domains: DimDictDomainDto[] = rawDomains.map((d: any) => ({
      domain_id: String(d?.domain_id ?? '').trim(),
      domain_name: String(d?.domain_name ?? '').trim(),
      description: String(d?.description ?? '').trim(),
      source_table: String(d?.source_table ?? '').trim(),
      source_column: String(d?.source_column ?? '').trim(),
      built_in: Boolean(d?.built_in),
      entries: Array.isArray(d?.entries)
        ? d.entries.map((e: any, idx: number) => ({
            code: String(e?.code ?? '').trim(),
            label: String(e?.label ?? e?.code ?? '').trim(),
            sort_order: Number.isFinite(Number(e?.sort_order)) ? Math.floor(Number(e.sort_order)) : idx + 1,
            enabled: Boolean(e?.enabled ?? true),
            notes: String(e?.notes ?? '').trim(),
          }))
        : [],
    }))
    return {
      ok: true,
      version: json.version != null ? Number(json.version) : undefined,
      updated_at: json.updated_at != null ? String(json.updated_at) : undefined,
      domains,
      store_path: json.store_path != null ? String(json.store_path) : undefined,
      hint: json.hint != null ? String(json.hint) : undefined,
    }
  } catch (e) {
    return { ok: false, domains: [], error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postDimDict(
  payload: { version?: number; domains: DimDictDomainDto[] },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  message?: string
  version?: number
  updated_at?: string
  domains?: DimDictDomainDto[]
  errors?: string[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim-dict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) {
      return {
        ok: false,
        error: json?.error ?? { message: `HTTP ${res.status}` },
        errors: Array.isArray(json?.errors) ? json.errors.map(String) : undefined,
      }
    }
    const fetchAgain = await fetchDimDict(signal)
    return {
      ok: true,
      message: json.message != null ? String(json.message) : undefined,
      version: json.version != null ? Number(json.version) : undefined,
      updated_at: json.updated_at != null ? String(json.updated_at) : undefined,
      domains: fetchAgain.ok ? fetchAgain.domains : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type SubjectCategoryRecomputeSummary = {
  run_id: string
  snapshot_id: string
  created_at: string
  category_summary: {
    total: number
    matched: number
    needs_review: number
    disabled_blocked: number
    by_org_category: Array<{
      org_category: string
      count: number
      org_category_display_name?: string
    }>
  }
  relation_summary: {
    relation_total: number
    trade_invoice_count_sum: number
    trade_amount_jshj_sum: number
  }
}

export async function fetchSubjectCategoryRecomputeLatest(signal?: AbortSignal): Promise<{
  ok: boolean
  latest: SubjectCategoryRecomputeSummary | null
  message?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/subject-category/recompute/latest', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, latest: null, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      latest: (json.latest as SubjectCategoryRecomputeSummary | null) ?? null,
      message: json.message != null ? String(json.message) : undefined,
    }
  } catch (e) {
    return { ok: false, latest: null, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postSubjectLibraryIngestFromDwd(
  payload?: { overwrite_manual_repairs?: boolean },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  message?: string
  result?: {
    run_id?: string
    header_rows_scanned?: number
    subjects_upserted?: number
    subjects_merged_name_key_into_tax?: number
    source_rows_upserted?: number
    manual_repair_preserved?: number
    overwrite_manual_repairs?: boolean
  }
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/subject-library/ingest-from-dwd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        overwrite_manual_repairs: Boolean(payload?.overwrite_manual_repairs),
      }),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      message: json.message != null ? String(json.message) : undefined,
      result: json.result,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type SubjectLibraryImportRejectSample = {
  seq_no?: string | number
  sheet?: string
  field?: string
  reason?: string
  exception_type?: string
}

/** multipart：file + 可选 snapshot_year（四位年度，写入快照口径） */
export async function postSubjectLibraryExternalImport(params: {
  file: File
  snapshotYear?: string
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  message?: string
  subjects_upserted?: number
  source_rows_written?: number
  import_batch_id?: string
  reject_row_samples?: SubjectLibraryImportRejectSample[]
  file_blocking?: boolean
  error?: { message?: string; detail?: string; exception_type?: string }
}> {
  const fd = new FormData()
  fd.append('file', params.file, params.file.name)
  if (params.snapshotYear?.trim()) fd.append('snapshot_year', params.snapshotYear.trim())
  try {
    const res = await apiFetch('/api/subject-library/import-external', {
      method: 'POST',
      body: fd,
      signal: params.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    const samples = Array.isArray(json?.reject_row_samples) ? json.reject_row_samples : []
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        error: json?.error ?? { message: `HTTP ${res.status}` },
        reject_row_samples: samples as SubjectLibraryImportRejectSample[],
        file_blocking: Boolean(json?.file_blocking),
      }
    }
    return {
      ok: true,
      message: json.message != null ? String(json.message) : undefined,
      subjects_upserted:
        json.subjects_upserted != null ? Number(json.subjects_upserted) : undefined,
      source_rows_written:
        json.source_rows_written != null ? Number(json.source_rows_written) : undefined,
      import_batch_id: json.import_batch_id != null ? String(json.import_batch_id) : undefined,
      reject_row_samples: samples as SubjectLibraryImportRejectSample[],
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** POST /api/subject-library/repair — 人工修正 dim_subject_master（见 docs/subject_library_data_repair.md） */
export async function postSubjectLibraryRepair(
  body: {
    subject_id: string
    subject_category?: 'org' | 'person'
    org_category?: string
    reason?: string
    client_hint?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  message?: string
  changed?: Array<{
    field: string
    old_value: string
    new_value: string
    old_display_name?: string
    new_display_name?: string
  }>
  error?: { message?: string; detail?: string; exception_type?: string }
}> {
  try {
    const res = await apiFetch('/api/subject-library/repair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      message: json.message != null ? String(json.message) : undefined,
      changed: Array.isArray(json.changed) ? json.changed : [],
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postSubjectCategoryRecompute(
  payload?: {
    with_relations?: boolean
    run_id?: string
    snapshot_id?: string
    overwrite_manual_repairs?: boolean
    async?: boolean
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  async?: boolean
  run_id?: string
  message?: string
  with_relations?: boolean
  result?: any
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/subject-category/recompute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        async: payload?.async !== false,
        with_relations: Boolean(payload?.with_relations),
        overwrite_manual_repairs: Boolean(payload?.overwrite_manual_repairs),
        ...(payload?.run_id ? { run_id: payload.run_id } : {}),
        ...(payload?.snapshot_id ? { snapshot_id: payload.snapshot_id } : {}),
      }),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      async: Boolean(json.async),
      run_id: json.run_id != null ? String(json.run_id) : undefined,
      message: json.message != null ? String(json.message) : undefined,
      with_relations: Boolean(json.with_relations),
      result: json.result,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postGroupEnterpriseYearRebuild(
  payload?: { stat_years?: number[]; replace_years?: boolean; async?: boolean; run_id?: string },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  async?: boolean
  run_id?: string
  message?: string
  total_written?: number
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim/group-enterprise-year/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        async: payload?.async !== false,
        replace_years: payload?.replace_years !== false,
        ...(payload?.stat_years?.length ? { stat_years: payload.stat_years } : {}),
        ...(payload?.run_id ? { run_id: payload.run_id } : {}),
      }),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      async: Boolean(json.async),
      run_id: json.run_id != null ? String(json.run_id) : undefined,
      message: json.message != null ? String(json.message) : undefined,
      total_written: json.total_written != null ? Number(json.total_written) : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type SubjectLibraryRowDto = {
  enterprise_id: string
  enterprise_name: string
  taxpayer_id: string
  /** 常见：platform | external；库侧 invoice/manual 等也可能原样出现（前端应归一化展示） */
  source_type: string
  subject_type: 'enterprise' | 'person'
  subject_category_code: string
  subject_category_name?: string
  has_rename_signal: boolean
  rename_edge_count: number
  rename_hint: string
  rename_timeline: string[]
  first_seen_batch_id: string
  last_seen_batch_id: string
  first_seen_date: string
  last_seen_date: string
  subject_snapshot_id: string
  quality_status: string
  category_status_note: string
  subject_build_run_id: string
  category_rule_version: string
}

export type SubjectLibrarySummaryDto = {
  total: number
  enterprise_count: number
  person_count: number
  needs_review_count: number
  rename_signal_subject_count: number
}

/** 与 config/subject_category*.yaml 同步的机构类别（org_category）筛选项 */
export type SubjectLibraryOrgCategoryOptionDto = {
  category_code: string
  category_name: string
}

export async function fetchSubjectLibraryOrgCategoryOptions(signal?: AbortSignal): Promise<{
  ok: boolean
  categories: SubjectLibraryOrgCategoryOptionDto[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/subject-library/org-category-options', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) {
      return {
        ok: false,
        categories: [],
        error: json?.error ?? { message: res.ok ? '读取失败' : `HTTP ${res.status}` },
      }
    }
    const raw = json.categories
    const categories = Array.isArray(raw)
      ? (raw as any[])
          .map((x) => ({
            category_code: String(x?.category_code ?? '').trim(),
            category_name: String(x?.category_name ?? x?.category_code ?? '').trim(),
          }))
          .filter((x) => x.category_code.length > 0)
          .map((x) => ({
            ...x,
            category_name: x.category_name || x.category_code,
          }))
      : []
    return { ok: true, categories }
  } catch (e) {
    return { ok: false, categories: [], error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchSubjectLibrarySummary(params: {
  subjectType?: 'all' | 'enterprise' | 'person'
  sourceType?: 'all' | 'platform' | 'external'
  keyword?: string
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  summary?: SubjectLibrarySummaryDto
  error?: { message?: string }
}> {
  try {
    const sp = new URLSearchParams()
    if (params.subjectType) sp.set('subject_type', params.subjectType)
    if (params.sourceType) sp.set('source_type', params.sourceType)
    const kwSum = (params.keyword ?? '').trim()
    if (kwSum) sp.set('keyword', kwSum)
    const res = await apiFetch(`/api/subject-library/summary?${sp.toString()}`, { signal: params.signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true, summary: json.summary }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchSubjectLibraryRows(params: {
  keyword?: string
  subjectType?: 'all' | 'enterprise' | 'person'
  sourceType?: 'all' | 'platform' | 'external'
  subjectCategory?: string
  renameSignal?: 'all' | 'yes' | 'no'
  /** all：不过滤；yes：仅主体信息需复核（category_status_note=needs_review）；no：排除需复核 */
  categoryReview?: 'all' | 'yes' | 'no'
  batchId?: string
  /** 每页条数，服务端上限 200 */
  limit?: number
  /** 跳过条数（分页） */
  offset?: number
  signal?: AbortSignal
}): Promise<{ ok: boolean; rows: SubjectLibraryRowDto[]; total: number; error?: { message?: string } }> {
  try {
    const sp = new URLSearchParams()
    const kwRows = (params.keyword ?? '').trim()
    if (kwRows) sp.set('keyword', kwRows)
    if (params.subjectType) sp.set('subject_type', params.subjectType)
    if (params.sourceType) sp.set('source_type', params.sourceType)
    if (params.subjectCategory) sp.set('subject_category', params.subjectCategory)
    if (params.renameSignal && params.renameSignal !== 'all') sp.set('rename_signal', params.renameSignal)
    if (params.categoryReview && params.categoryReview !== 'all') sp.set('category_review', params.categoryReview)
    if (params.batchId) sp.set('batch_id', params.batchId)
    sp.set('limit', String(Math.max(1, Math.min(200, Math.floor(params.limit ?? 50)))))
    const off = params.offset != null ? Math.max(0, Math.floor(params.offset)) : 0
    sp.set('offset', String(off))
    const res = await apiFetch(`/api/subject-library/rows?${sp.toString()}`, { signal: params.signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, rows: [], total: 0, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      rows: Array.isArray(json.rows) ? (json.rows as SubjectLibraryRowDto[]) : [],
      total: Number(json.total ?? 0),
    }
  } catch (e) {
    return { ok: false, rows: [], total: 0, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postSubjectLibraryRebuildRenameSignals(
  signal?: AbortSignal,
  opts?: { sync?: boolean },
): Promise<{
  ok: boolean
  async?: boolean
  message?: string
  run_id?: string
  signals_written?: number
  error?: { message?: string }
}> {
  try {
    const asyncMode = opts?.sync !== true
    const res = await apiFetch('/api/subject-library/rebuild-rename-signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ async: asyncMode }),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    if (!json?.ok) {
      return {
        ok: false,
        async: json.async === false,
        run_id: json.run_id != null ? String(json.run_id) : undefined,
        error: json?.error ?? { message: '重建更名信号失败' },
      }
    }
    return {
      ok: true,
      async: json.async === true,
      message: json.message != null ? String(json.message) : undefined,
      run_id: json.run_id != null ? String(json.run_id) : undefined,
      signals_written: json.signals_written != null ? Number(json.signals_written) : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type SubjectRenameRebuildStatus = 'queued' | 'running' | 'success' | 'failed' | string

export async function fetchSubjectLibraryRenameRebuildStatus(
  runId: string,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  status?: SubjectRenameRebuildStatus
  message?: string
  signals_written?: number
  restored_from_task_log?: boolean
  error?: { message?: string; exception_type?: string; detail?: string }
}> {
  try {
    const sp = new URLSearchParams()
    sp.set('run_id', runId)
    const res = await apiFetch(`/api/subject-library/rename-rebuild-status?${sp.toString()}`, {
      method: 'GET',
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    if (!json?.ok) {
      return { ok: false, error: json?.error ?? { message: '查询状态失败' } }
    }
    return {
      ok: true,
      status: json.status != null ? String(json.status) : undefined,
      message: json.message != null ? String(json.message) : undefined,
      signals_written: json.signals_written != null ? Number(json.signals_written) : undefined,
      restored_from_task_log: json.restored_from_task_log === true,
      error: json.error != null && typeof json.error === 'object' ? json.error : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type SubjectLibraryRenameEventDto = {
  from_name: string
  to_name: string
  transition_date: string
  confidence: string
  evidence_invoice_count: number
}

/** 主体库弹窗：dwd_inv_header 溯源行（与后端 api_subject_library_invoice_headers 一致） */
export type SubjectLibraryInvoiceHeaderDto = {
  header_uuid: string
  fpdm: string
  fphm: string
  sdfphm: string
  xfmc: string
  gfmc: string
  kprq: string
  stat_year: number | null
  jshj: number | null
}

export async function fetchSubjectLibraryInvoiceHeaders(params: {
  subjectId: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  subject_name?: string
  subject_no?: string
  rows: SubjectLibraryInvoiceHeaderDto[]
  total: number
  warning?: string
  error?: { message?: string }
}> {
  try {
    const sp = new URLSearchParams()
    sp.set('subject_id', params.subjectId.trim())
    sp.set('limit', String(Math.max(1, Math.min(200, Math.floor(params.limit ?? 50)))))
    sp.set('offset', String(params.offset != null ? Math.max(0, Math.floor(params.offset)) : 0))
    const res = await apiFetch(`/api/subject-library/invoice-headers?${sp.toString()}`, {
      signal: params.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        rows: [],
        total: 0,
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    const rawRows = Array.isArray(json.rows) ? json.rows : []
    const rows: SubjectLibraryInvoiceHeaderDto[] = rawRows.map((x: any) => ({
      header_uuid: String(x?.header_uuid ?? ''),
      fpdm: String(x?.fpdm ?? ''),
      fphm: String(x?.fphm ?? ''),
      sdfphm: String(x?.sdfphm ?? ''),
      xfmc: String(x?.xfmc ?? ''),
      gfmc: String(x?.gfmc ?? ''),
      kprq: String(x?.kprq ?? ''),
      stat_year: x?.stat_year != null && x.stat_year !== '' ? Number(x.stat_year) : null,
      jshj: x?.jshj != null && x.jshj !== '' ? Number(x.jshj) : null,
    }))
    return {
      ok: true,
      subject_name: json.subject_name != null ? String(json.subject_name) : undefined,
      subject_no: json.subject_no != null ? String(json.subject_no) : undefined,
      rows,
      total: Number(json.total ?? 0),
      warning: json.warning != null ? String(json.warning) : undefined,
    }
  } catch (e) {
    return { ok: false, rows: [], total: 0, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchSubjectLibraryRenameTimeline(
  subjectId: string,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  events?: SubjectLibraryRenameEventDto[]
  timeline_lines?: string[]
  error?: { message?: string }
}> {
  try {
    const sp = new URLSearchParams()
    sp.set('subject_id', subjectId.trim())
    const res = await apiFetch(`/api/subject-library/rename-timeline?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      events: Array.isArray(json.events) ? json.events : [],
      timeline_lines: Array.isArray(json.timeline_lines) ? json.timeline_lines : [],
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** 年度一级企业名单 dim_level1_enterprise_year */
export type Level1EnterpriseYearRow = {
  stat_year: string
  level1_enterprise_id: string
  level1_enterprise_name: string
  display_order: number
  is_active: boolean
  remark?: string
  data_source?: string
  updated_at?: string
  /** 花名册 dim_enterprise_year_roster 中与国家出资企业税号匹配的成员总数 */
  group_member_count?: number
  /** 有效成员数（is_member=true） */
  group_active_member_count?: number
  /** 被审企业台账 dim_audited_enterprise_registry.state_investor */
  state_investor?: string
  /** 集团成员表推导的国家出资企业锚点（产权根>管理根>一级集团） */
  soe_anchor_name?: string
}

export type Level1EnterpriseYearPreviewRow = {
  level1_enterprise_id: string
  level1_enterprise_name: string
  display_order: number
  is_active: boolean
  remark?: string
  derive_hint?: string
  already_in_target?: boolean
  from_group_extra?: boolean
}

export type Level1EnterpriseYearMemberRow = {
  enterprise_id: string
  enterprise_name: string
  is_member: boolean
  state_investor?: string
  state_investor_unified_credit_code?: string
  quality_status?: string
  quality_issue?: string
}

export type EnterpriseYearRosterGroupSummary = {
  state_investor: string
  state_investor_unified_credit_code: string
  member_count: number
  active_member_count: number
  conflict_count: number
}

export type EnterpriseYearRosterRow = {
  enterprise_id: string
  enterprise_name: string
  state_investor: string
  state_investor_unified_credit_code: string
  is_member: boolean
  quality_status: string
  quality_issue: string
  source_record_id: string
  updated_at: string
  in_registry: boolean
  in_manual: boolean
  data_source: string
  manual_note: string
}

export type EnterpriseYearRosterCopyPreview = {
  source_year: string
  target_year: string
  source_row_count: number
  to_insert_count: number
  to_skip_count: number
  conflict_hint_count: number
  to_insert?: EnterpriseYearRosterRow[]
  to_skip?: Record<string, unknown>[]
  conflict_hints?: { enterprise_id: string; hint: string }[]
}

export type EnterpriseYearRosterKpi = {
  group_count: number
  total_members: number
  active_member_count: number
  conflict_count: number
}

export async function fetchEnterpriseYearRosterBootstrap(
  params: {
    statYear?: string
    stateInvestorKw?: string
    enterpriseKw?: string
    limit?: number
    offset?: number
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  stat_years?: string[]
  data_stat_years?: string[]
  default_stat_year?: string
  table_ready?: boolean
  stat_year?: string
  group_count?: number
  total_members?: number
  active_member_count?: number
  conflict_count?: number
  rows?: EnterpriseYearRosterRow[]
  total?: number
  limit?: number
  offset?: number
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  if (params.statYear?.trim()) sp.set('stat_year', params.statYear.trim())
  if (params.stateInvestorKw?.trim()) sp.set('state_investor_kw', params.stateInvestorKw.trim())
  if (params.enterpriseKw?.trim()) sp.set('enterprise_kw', params.enterpriseKw.trim())
  sp.set('limit', String(params.limit ?? 50))
  sp.set('offset', String(params.offset ?? 0))
  try {
    const res = await apiFetch(`/api/dim/enterprise-year-roster/bootstrap?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !json?.ok) return { ok: false, error: (json?.error as { message?: string }) ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      stat_years: Array.isArray(json.stat_years) ? (json.stat_years as string[]) : [],
      data_stat_years: Array.isArray(json.data_stat_years) ? (json.data_stat_years as string[]) : [],
      default_stat_year: json.default_stat_year != null ? String(json.default_stat_year) : undefined,
      table_ready: Boolean(json.table_ready),
      stat_year: json.stat_year != null ? String(json.stat_year) : params.statYear,
      group_count: Number(json.group_count ?? 0),
      total_members: Number(json.total_members ?? 0),
      active_member_count: Number(json.active_member_count ?? 0),
      conflict_count: Number(json.conflict_count ?? 0),
      rows: Array.isArray(json.rows) ? (json.rows as EnterpriseYearRosterRow[]) : [],
      total: Number(json.total ?? 0),
      limit: Number(json.limit ?? 50),
      offset: Number(json.offset ?? 0),
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchEnterpriseYearRosterKpi(
  params: { statYear: string },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  stat_year?: string
  group_count?: number
  total_members?: number
  active_member_count?: number
  conflict_count?: number
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  try {
    const res = await apiFetch(`/api/dim/enterprise-year-roster/kpi?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !json?.ok) return { ok: false, error: (json?.error as { message?: string }) ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      stat_year: json.stat_year != null ? String(json.stat_year) : params.statYear,
      group_count: Number(json.group_count ?? 0),
      total_members: Number(json.total_members ?? 0),
      active_member_count: Number(json.active_member_count ?? 0),
      conflict_count: Number(json.conflict_count ?? 0),
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchEnterpriseYearRosterMeta(signal?: AbortSignal): Promise<{
  ok: boolean
  stat_years?: string[]
  data_stat_years?: string[]
  default_stat_year?: string
  table_ready?: boolean
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim/enterprise-year-roster/meta', { signal })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !json?.ok) return { ok: false, error: (json?.error as { message?: string }) ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      stat_years: Array.isArray(json.stat_years) ? (json.stat_years as string[]) : [],
      data_stat_years: Array.isArray(json.data_stat_years) ? (json.data_stat_years as string[]) : [],
      default_stat_year: json.default_stat_year != null ? String(json.default_stat_year) : undefined,
      table_ready: Boolean(json.table_ready),
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchEnterpriseYearRosterSummary(
  params: { statYear: string; stateInvestorKw?: string },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  stat_year?: string
  group_count?: number
  total_members?: number
  groups?: EnterpriseYearRosterGroupSummary[]
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.stateInvestorKw?.trim()) sp.set('state_investor_kw', params.stateInvestorKw.trim())
  try {
    const res = await apiFetch(`/api/dim/enterprise-year-roster/summary?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !json?.ok) return { ok: false, error: (json?.error as { message?: string }) ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      stat_year: json.stat_year != null ? String(json.stat_year) : params.statYear,
      group_count: Number(json.group_count ?? 0),
      total_members: Number(json.total_members ?? 0),
      groups: Array.isArray(json.groups) ? (json.groups as EnterpriseYearRosterGroupSummary[]) : [],
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchEnterpriseYearRosterList(
  params: {
    statYear: string
    stateInvestor?: string
    stateInvestorCode?: string
    stateInvestorKw?: string
    enterpriseKw?: string
    qualityStatus?: string
    dataSource?: string
    limit?: number
    offset?: number
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  stat_year?: string
  rows?: EnterpriseYearRosterRow[]
  total?: number
  limit?: number
  offset?: number
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.stateInvestor?.trim()) sp.set('state_investor', params.stateInvestor.trim())
  if (params.stateInvestorCode?.trim()) sp.set('state_investor_code', params.stateInvestorCode.trim())
  if (params.stateInvestorKw?.trim()) sp.set('state_investor_kw', params.stateInvestorKw.trim())
  if (params.enterpriseKw?.trim()) sp.set('enterprise_kw', params.enterpriseKw.trim())
  if (params.qualityStatus?.trim()) sp.set('quality_status', params.qualityStatus.trim())
  if (params.dataSource?.trim()) sp.set('data_source', params.dataSource.trim())
  sp.set('limit', String(params.limit ?? 50))
  sp.set('offset', String(params.offset ?? 0))
  try {
    const res = await apiFetch(`/api/dim/enterprise-year-roster/list?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !json?.ok) return { ok: false, error: (json?.error as { message?: string }) ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      stat_year: json.stat_year != null ? String(json.stat_year) : params.statYear,
      rows: Array.isArray(json.rows) ? (json.rows as EnterpriseYearRosterRow[]) : [],
      total: Number(json.total ?? 0),
      limit: Number(json.limit ?? 50),
      offset: Number(json.offset ?? 0),
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postEnterpriseYearRosterRebuild(
  body: { statYears?: number[]; replaceYears?: boolean },
  signal?: AbortSignal,
): Promise<{ ok: boolean; rows_written?: number; run_id?: string; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/dim/enterprise-year-roster/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stat_years: body.statYears,
        replace_years: body.replaceYears ?? false,
      }),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !json?.ok) return { ok: false, error: (json?.error as { message?: string }) ?? { message: `HTTP ${res.status}` } }
    return { ok: true, rows_written: Number(json.rows_written ?? 0), run_id: json.run_id != null ? String(json.run_id) : undefined }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type EnterpriseYearRosterConsistencyCheck = {
  check_id: string
  description: string
  violation_cnt: number
  is_info?: boolean
  passed?: boolean
}

export async function fetchEnterpriseYearRosterConsistency(
  params: { statYear?: string; repair?: boolean } = {},
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  stat_year?: string
  checks?: EnterpriseYearRosterConsistencyCheck[]
  hard_fail_count?: number
  repaired_rows?: number
  message?: string
  error?: { message?: string }
}> {
  const qs = new URLSearchParams()
  if (params.statYear) qs.set('stat_year', params.statYear)
  if (params.repair) qs.set('repair', 'true')
  try {
    const res = await apiFetch(`/api/dim/enterprise-year-roster/consistency?${qs.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return {
      ok: Boolean(json.ok),
      stat_year: json.stat_year != null ? String(json.stat_year) : undefined,
      checks: Array.isArray(json.checks) ? (json.checks as EnterpriseYearRosterConsistencyCheck[]) : [],
      hard_fail_count: Number(json.hard_fail_count ?? 0),
      repaired_rows: Number(json.repaired_rows ?? 0),
      message: json.message != null ? String(json.message) : undefined,
      error: json.error as { message?: string } | undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postEnterpriseYearRosterManualUpsert(
  body: {
    statYear: string
    enterpriseId: string
    enterpriseName: string
    stateInvestor: string
    stateInvestorUnifiedCreditCode?: string
    isMember?: boolean
    manualNote?: string
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; data_source?: string; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/dim/enterprise-year-roster/manual/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stat_year: body.statYear,
        enterprise_id: body.enterpriseId,
        enterprise_name: body.enterpriseName,
        state_investor: body.stateInvestor,
        state_investor_unified_credit_code: body.stateInvestorUnifiedCreditCode,
        is_member: body.isMember ?? true,
        manual_note: body.manualNote,
      }),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !json?.ok) return { ok: false, error: (json?.error as { message?: string }) ?? { message: `HTTP ${res.status}` } }
    return { ok: true, data_source: json.data_source != null ? String(json.data_source) : undefined }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postEnterpriseYearRosterManualDelete(
  body: { statYear: string; enterpriseId: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/dim/enterprise-year-roster/manual/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stat_year: body.statYear, enterprise_id: body.enterpriseId }),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !json?.ok) return { ok: false, error: (json?.error as { message?: string }) ?? { message: `HTTP ${res.status}` } }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postEnterpriseYearRosterCopyPreview(
  body: {
    sourceYear: string
    targetYear: string
    includePending?: boolean
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: { message?: string } } & Partial<EnterpriseYearRosterCopyPreview>> {
  try {
    const res = await apiFetch('/api/dim/enterprise-year-roster/copy/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_year: body.sourceYear,
        target_year: body.targetYear,
        include_pending: body.includePending ?? false,
      }),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !json?.ok) return { ok: false, error: (json?.error as { message?: string }) ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      source_year: json.source_year != null ? String(json.source_year) : body.sourceYear,
      target_year: json.target_year != null ? String(json.target_year) : body.targetYear,
      source_row_count: Number(json.source_row_count ?? 0),
      to_insert_count: Number(json.to_insert_count ?? 0),
      to_skip_count: Number(json.to_skip_count ?? 0),
      conflict_hint_count: Number(json.conflict_hint_count ?? 0),
      conflict_hints: Array.isArray(json.conflict_hints)
        ? (json.conflict_hints as { enterprise_id: string; hint: string }[])
        : [],
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postEnterpriseYearRosterCopyExecute(
  body: {
    sourceYear: string
    targetYear: string
    includePending?: boolean
    overwriteManual?: boolean
    fillEmptyRegistry?: boolean
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; inserted?: number; updated?: number; skipped?: number; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/dim/enterprise-year-roster/copy/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_year: body.sourceYear,
        target_year: body.targetYear,
        include_pending: body.includePending ?? false,
        overwrite_manual: body.overwriteManual ?? false,
        fill_empty_registry: body.fillEmptyRegistry ?? false,
      }),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !json?.ok) return { ok: false, error: (json?.error as { message?: string }) ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      inserted: Number(json.inserted ?? 0),
      updated: Number(json.updated ?? 0),
      skipped: Number(json.skipped ?? 0),
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchLevel1EnterpriseYearMembers(
  params: { statYear: string; level1EnterpriseId: string; keyword?: string },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  stat_year?: string
  level1_enterprise_id?: string
  level1_enterprise_name?: string
  in_level1_list?: boolean
  members?: Level1EnterpriseYearMemberRow[]
  total?: number
  active_member_count?: number
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('level1_enterprise_id', params.level1EnterpriseId.trim())
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  try {
    const res = await apiFetch(`/api/dim/level1-enterprise-year/members?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      stat_year: json.stat_year != null ? String(json.stat_year) : params.statYear,
      level1_enterprise_id: json.level1_enterprise_id != null ? String(json.level1_enterprise_id) : params.level1EnterpriseId,
      level1_enterprise_name: json.level1_enterprise_name != null ? String(json.level1_enterprise_name) : undefined,
      in_level1_list: Boolean(json.in_level1_list),
      members: Array.isArray(json.members) ? (json.members as Level1EnterpriseYearMemberRow[]) : [],
      total: Number(json.total ?? 0),
      active_member_count: Number(json.active_member_count ?? 0),
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

function level1ApiFriendlyError(msg: string | undefined, status?: number): string | undefined {
  if (msg === 'Not Found' || status === 404) {
    return '本地 API 未识别「年度一级企业名单」接口（Not Found）。请重启本地 API（dev.bat api 或 dev.bat all）后再打开本页；与是否已导入数据无关。'
  }
  return msg
}

export async function fetchLevel1EnterpriseYearMeta(signal?: AbortSignal): Promise<{
  ok: boolean
  stat_years?: string[]
  row_counts_by_year?: Record<string, number>
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim/level1-enterprise-year/meta', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      const raw = json?.error?.message != null ? String(json.error.message) : `HTTP ${res.status}`
      return { ok: false, error: { message: level1ApiFriendlyError(raw, res.status) ?? raw } }
    }
    return {
      ok: true,
      stat_years: Array.isArray(json.stat_years) ? json.stat_years.map(String) : [],
      row_counts_by_year: json.row_counts_by_year ?? {},
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchLevel1EnterpriseYearList(
  params: { statYear: string; keyword?: string; activeOnly?: boolean },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  stat_years?: string[]
  selected_stat_year?: string
  rows?: Level1EnterpriseYearRow[]
  total?: number
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  if (params.activeOnly) sp.set('active_only', '1')
  try {
    const res = await apiFetch(`/api/dim/level1-enterprise-year/list?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      const raw = json?.error?.message != null ? String(json.error.message) : `HTTP ${res.status}`
      return { ok: false, error: { message: level1ApiFriendlyError(raw, res.status) ?? raw } }
    }
    return {
      ok: true,
      stat_years: Array.isArray(json.stat_years) ? json.stat_years.map(String) : [],
      selected_stat_year: json.selected_stat_year != null ? String(json.selected_stat_year) : params.statYear,
      rows: Array.isArray(json.rows) ? (json.rows as Level1EnterpriseYearRow[]) : [],
      total: Number(json.total ?? 0),
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchLevel1EnterpriseYearCandidates(
  params: { statYear: string },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  candidates?: { level1_enterprise_id: string; level1_enterprise_name: string }[]
  total?: number
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  try {
    const res = await apiFetch(`/api/dim/level1-enterprise-year/candidates?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      candidates: Array.isArray(json.candidates) ? json.candidates : [],
      total: Number(json.total ?? 0),
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postLevel1EnterpriseYearUpsert(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/dim/level1-enterprise-year/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postLevel1EnterpriseYearDelete(
  body: { stat_year: string; level1_enterprise_id: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/dim/level1-enterprise-year/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postLevel1EnterpriseYearImportBatch(
  body: {
    stat_year: string
    rows: { level1_enterprise_id: string; level1_enterprise_name: string; display_order?: number; remark?: string; is_active?: boolean }[]
    replace_year?: boolean
    data_source?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  inserted?: number
  updated?: number
  rejected_count?: number
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim/level1-enterprise-year/import-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      inserted: Number(json.inserted ?? 0),
      updated: Number(json.updated ?? 0),
      rejected_count: Number(json.rejected_count ?? 0),
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postLevel1EnterpriseYearPreviewFromPrevious(
  body: {
    target_stat_year: string
    source_stat_year?: string
    mode: 'copy' | 'derive'
    only_active?: boolean
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  target_stat_year?: string
  source_stat_year?: string
  mode?: string
  rows?: Level1EnterpriseYearPreviewRow[]
  empty_source?: boolean
  preview_row_count?: number
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim/level1-enterprise-year/preview-from-previous', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      target_stat_year: json.target_stat_year != null ? String(json.target_stat_year) : body.target_stat_year,
      source_stat_year: json.source_stat_year != null ? String(json.source_stat_year) : undefined,
      mode: json.mode != null ? String(json.mode) : body.mode,
      rows: Array.isArray(json.rows) ? (json.rows as Level1EnterpriseYearPreviewRow[]) : [],
      empty_source: Boolean(json.empty_source),
      preview_row_count: Number(json.preview_row_count ?? 0),
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postLevel1EnterpriseYearCopyFromPrevious(
  body: {
    target_stat_year: string
    source_stat_year?: string
    replace_year?: boolean
    only_active?: boolean
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  skipped?: boolean
  message?: string
  inserted?: number
  updated?: number
  source_stat_year?: string
  target_stat_year?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim/level1-enterprise-year/copy-from-previous', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || (!json?.ok && !json?.skipped)) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      skipped: Boolean(json.skipped),
      message: json.message != null ? String(json.message) : undefined,
      inserted: Number(json.inserted ?? 0),
      updated: Number(json.updated ?? 0),
      source_stat_year: json.source_stat_year != null ? String(json.source_stat_year) : undefined,
      target_stat_year: json.target_stat_year != null ? String(json.target_stat_year) : body.target_stat_year,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** 管理与产权层级信息（dim_audited_enterprise_registry） */
export type AuditedEnterpriseRegistryRow = {
  rowId: string
  snapshotYear: string
  code: string
  name: string
  domesticOverseas: string
  detailAddress: string
  currency: string
  registeredCapital: string
  registrationDate: string
  nationalEconomyIndustryMajor: string
  enterpriseCategory: string
  sasacAuthority: string
  sasacRelation: string
  consolidatedReporting: string
  listedCompany: string
  mainBusiness: string
  stateInvestor: string
  mgmtLevel: number
  mgmtParent: string
  equityLevel: number
  shareholders: string
}

export type AuditedEnterpriseRegistrySummary = {
  total: number
  listed_company: number
  overseas: number
  mgmt_parent_maintained: number
  equity_parent_maintained: number
  main_business_maintained: number
}

export async function fetchAuditedEnterpriseRegistryMeta(signal?: AbortSignal): Promise<{
  ok: boolean
  snapshot_years?: string[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/audited-enterprise/registry/meta', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const snapshot_years = Array.isArray(json.snapshot_years)
      ? json.snapshot_years.map((x: unknown) => String(x))
      : []
    return { ok: true, snapshot_years }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, error: { message: 'aborted' } }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchAuditedEnterpriseRegistry(
  params: {
    snapshotYear: string
    stateInvestor?: string
    enterprise?: string
    limit?: number
    offset?: number
    includeYears?: boolean
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  snapshot_years?: string[]
  selected_year?: string
  rows?: AuditedEnterpriseRegistryRow[]
  total?: number
  limit?: number
  offset?: number
  summary?: AuditedEnterpriseRegistrySummary
  error?: { message?: string; detail?: string; exception_type?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('snapshot_year', params.snapshotYear.trim())
  if (params.stateInvestor?.trim()) sp.set('state_investor', params.stateInvestor.trim())
  if (params.enterprise?.trim()) sp.set('enterprise', params.enterprise.trim())
  sp.set('limit', String(params.limit ?? 50))
  sp.set('offset', String(params.offset ?? 0))
  if (params.includeYears === false) sp.set('include_years', '0')
  try {
    const res = await apiFetch(`/api/audited-enterprise/registry?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const rows = Array.isArray(json.rows) ? (json.rows as AuditedEnterpriseRegistryRow[]) : []
    const snapshot_years = Array.isArray(json.snapshot_years)
      ? json.snapshot_years.map((x: unknown) => String(x))
      : []
    const summaryRaw = json.summary
    const summary: AuditedEnterpriseRegistrySummary | undefined =
      summaryRaw && typeof summaryRaw === 'object'
        ? {
            total: Number(summaryRaw.total ?? 0),
            listed_company: Number(summaryRaw.listed_company ?? 0),
            overseas: Number(summaryRaw.overseas ?? 0),
            mgmt_parent_maintained: Number(summaryRaw.mgmt_parent_maintained ?? 0),
            equity_parent_maintained: Number(summaryRaw.equity_parent_maintained ?? 0),
            main_business_maintained: Number(summaryRaw.main_business_maintained ?? 0),
          }
        : undefined
    return {
      ok: true,
      snapshot_years,
      selected_year: json.selected_year != null ? String(json.selected_year) : params.snapshotYear,
      rows,
      total: json.total != null ? Number(json.total) : rows.length,
      limit: json.limit != null ? Number(json.limit) : params.limit,
      offset: json.offset != null ? Number(json.offset) : params.offset,
      summary,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, error: { message: 'aborted' } }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postAuditedEnterpriseRegistryRow(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; row_id?: string; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/audited-enterprise/registry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return { ok: true, row_id: json.row_id != null ? String(json.row_id) : undefined }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postAuditedEnterpriseRegistryBootstrapDemo(signal?: AbortSignal): Promise<{
  ok: boolean
  inserted?: number
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/audited-enterprise/registry/bootstrap-demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return { ok: true, inserted: Number(json.inserted) }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type ExcelImportResult = {
  ok: boolean
  imported?: number
  rejected?: number
  reject_row_samples?: Array<{
    seq_no?: number
    sheet?: string
    field?: string
    reason?: string
    exception_type?: string
  }>
  reject_row_ranges?: Array<{ seq_no_start: number; seq_no_end: number; reason: string }>
  file_blocking?: boolean
  error?: { message?: string }
}

export async function postAuditedEnterpriseRegistryImportExcel(
  file: File,
  signal?: AbortSignal,
): Promise<ExcelImportResult> {
  const fd = new FormData()
  fd.append('file', file)
  try {
    const res = await apiFetch('/api/dim/audited-enterprise/registry/import-excel', {
      method: 'POST',
      body: fd,
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    return {
      ok: Boolean(json?.ok),
      imported: Number(json?.imported ?? 0),
      rejected: Number(json?.rejected ?? 0),
      reject_row_samples: json?.reject_row_samples ?? [],
      reject_row_ranges: json?.reject_row_ranges ?? [],
      file_blocking: Boolean(json?.file_blocking),
      error: json?.ok ? undefined : json?.error ?? { message: `HTTP ${res.status}` },
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** 出资与股权比例信息（dim_audited_enterprise_contribution） */
export type AuditedEnterpriseContributionRow = {
  rowId: string
  snapshotYear: string
  unifiedCreditCode: string
  investeeName: string
  stateInvestorEnterprise: string
  stateInvestorUnifiedCreditCode: string
  contributorName: string
  contributorOrgCode: string
  contributorCategory: string
  contributionInfo: string
  relationToTarget: string
  currency: string
  subscribedAmountWan: number
  shareRatio: number
}

export async function fetchAuditedEnterpriseContribution(
  params: { snapshotYear: string; keyword?: string },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  snapshot_years?: string[]
  selected_year?: string
  rows?: AuditedEnterpriseContributionRow[]
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('snapshot_year', params.snapshotYear.trim())
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  try {
    const res = await apiFetch(`/api/audited-enterprise/contribution?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const rows = Array.isArray(json.rows) ? (json.rows as AuditedEnterpriseContributionRow[]) : []
    const snapshot_years = Array.isArray(json.snapshot_years)
      ? json.snapshot_years.map((x: unknown) => String(x))
      : []
    return {
      ok: true,
      snapshot_years,
      selected_year: json.selected_year != null ? String(json.selected_year) : params.snapshotYear,
      rows,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postAuditedEnterpriseContributionRow(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; row_id?: string; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/audited-enterprise/contribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return { ok: true, row_id: json.row_id != null ? String(json.row_id) : undefined }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postAuditedEnterpriseContributionBootstrapDemo(signal?: AbortSignal): Promise<{
  ok: boolean
  inserted?: number
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/audited-enterprise/contribution/bootstrap-demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return { ok: true, inserted: Number(json.inserted) }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postAuditedEnterpriseContributionImportExcel(
  file: File,
  signal?: AbortSignal,
): Promise<ExcelImportResult> {
  const fd = new FormData()
  fd.append('file', file)
  try {
    const res = await apiFetch('/api/dim/audited-enterprise/contribution/import-excel', {
      method: 'POST',
      body: fd,
      signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    return {
      ok: Boolean(json?.ok),
      imported: Number(json?.imported ?? 0),
      rejected: Number(json?.rejected ?? 0),
      reject_row_samples: json?.reject_row_samples ?? [],
      reject_row_ranges: json?.reject_row_ranges ?? [],
      file_blocking: Boolean(json?.file_blocking),
      error: json?.ok ? undefined : json?.error ?? { message: `HTTP ${res.status}` },
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** 被审企业 → 发票主体映射（台账 × 主体库 × dwd_inv_header） */
export type AuditedEnterpriseInvoiceLinkRow = {
  name: string
  code: string
  stateCapitalStatus: string
  matchKey: string
  linkedTaxpayerId: string
  matchStatus: string
  pendingReason?: string
}

export async function fetchAuditedEnterpriseInvoiceLink(
  params: { snapshotYear: string },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  snapshot_years?: string[]
  selected_year?: string
  rows?: AuditedEnterpriseInvoiceLinkRow[]
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('snapshot_year', params.snapshotYear.trim())
  try {
    const res = await apiFetch(`/api/audited-enterprise/invoice-link?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const rows = Array.isArray(json.rows) ? (json.rows as AuditedEnterpriseInvoiceLinkRow[]) : []
    const snapshot_years = Array.isArray(json.snapshot_years)
      ? json.snapshot_years.map((x: unknown) => String(x))
      : []
    return {
      ok: true,
      snapshot_years,
      selected_year: json.selected_year != null ? String(json.selected_year) : params.snapshotYear,
      rows,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** 被审主体关系树节点 enrichment */
export type AuditedEnterpriseRelationEnrichment = {
  entity_id?: string
  subject_id?: string
  has_buyer_role?: boolean
  has_seller_role?: boolean
  invoice_count?: number
  role_label?: string
  match_status?: string
  match_key?: string
  subject_no?: string
  subject_name?: string
  in_roster?: boolean
  in_analysis_pool?: boolean
}

export type AuditedEnterpriseRelationTreeNode = {
  id: string
  name: string
  level: number
  parent_id: string | null
  parent_name: string
  children: AuditedEnterpriseRelationTreeNode[]
  registry?: AuditedEnterpriseRegistryRow
  enrichment?: AuditedEnterpriseRelationEnrichment
}

export type DimOrgHierTreeNode = {
  id: string
  name: string
  entity_fullname?: string
  level: number
  parent_id: string | null
  parent_name: string
  sort_no?: number
  path?: string
  is_hier_diff?: boolean
  hier_diff_note?: string
  eq_shareholding_ratio?: number | null
  children: DimOrgHierTreeNode[]
}

export type DimOrgHierImportResult = {
  ok: boolean
  dry_run?: boolean
  stat_year?: number
  row_count?: number
  success?: number
  inserted?: number
  updated?: number
  hier_diff_count?: number
  log_count?: number
  warnings?: string[]
  errors?: string[]
  reject_row_samples?: Array<{ seq_no?: number; sheet?: string; field?: string; reason?: string; entity_id?: string }>
  error?: { message?: string }
}

export const DIM_ORG_HIER_TASK_CODE = 'dim.org_hier.build'

export async function fetchDimOrgHierMeta(signal?: AbortSignal): Promise<{
  ok: boolean
  stat_years?: string[]
  row_count?: number
  empty_hint?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim/org-hier/meta', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      stat_years: Array.isArray(json.stat_years) ? json.stat_years.map(String) : [],
      row_count: json.row_count != null ? Number(json.row_count) : undefined,
      empty_hint: json.empty_hint != null ? String(json.empty_hint) : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDimOrgHierTree(
  params: {
    statYear?: string
    tree: 'mg' | 'eq'
    keyword?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  stat_years?: string[]
  selected_year?: string
  nodes?: DimOrgHierTreeNode[]
  node_count?: number
  empty_hint?: string
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('tree', params.tree)
  if (params.statYear?.trim()) sp.set('stat_year', params.statYear.trim())
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  try {
    const res = await apiFetch(`/api/dim/org-hier/tree?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      stat_years: Array.isArray(json.stat_years) ? json.stat_years.map(String) : [],
      selected_year: json.selected_year != null ? String(json.selected_year) : params.statYear,
      nodes: Array.isArray(json.nodes) ? (json.nodes as DimOrgHierTreeNode[]) : [],
      node_count: json.node_count != null ? Number(json.node_count) : undefined,
      empty_hint: json.empty_hint != null ? String(json.empty_hint) : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDimOrgHierRows(
  params: {
    statYear?: string
    keyword?: string
    diffOnly?: boolean
    page?: number
    pageSize?: number
    sort?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  stat_years?: string[]
  selected_year?: string
  rows?: AuditedEnterpriseRelationListRow[]
  total?: number
  page?: number
  page_size?: number
  kpis?: AuditedEnterpriseRelationKpis & { hier_diff?: number; mg_change_count?: number; eq_change_count?: number; log_count?: number }
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  if (params.statYear?.trim()) sp.set('stat_year', params.statYear.trim())
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  if (params.diffOnly) sp.set('diff_only', 'true')
  if (params.page != null) sp.set('page', String(params.page))
  if (params.pageSize != null) sp.set('page_size', String(params.pageSize))
  if (params.sort?.trim()) sp.set('sort', params.sort.trim())
  try {
    const res = await apiFetch(`/api/dim/org-hier/rows?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      stat_years: Array.isArray(json.stat_years) ? json.stat_years.map(String) : [],
      selected_year: json.selected_year != null ? String(json.selected_year) : params.statYear,
      rows: Array.isArray(json.rows) ? (json.rows as AuditedEnterpriseRelationListRow[]) : [],
      total: json.total != null ? Number(json.total) : 0,
      page: json.page != null ? Number(json.page) : params.page,
      page_size: json.page_size != null ? Number(json.page_size) : params.pageSize,
      kpis: json.kpis,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postDimOrgHierImport(params: {
  file: File
  dryRun?: boolean
}): Promise<DimOrgHierImportResult> {
  const fd = new FormData()
  fd.append('file', params.file)
  if (params.dryRun) fd.append('dry_run', 'true')
  try {
    const res = await apiFetch('/api/dim/org-hier/import', { method: 'POST', body: fd })
    const json = (await res.json().catch(() => ({}))) as DimOrgHierImportResult
    if (!res.ok && !json.ok) {
      return { ...json, ok: false, error: json.error ?? { message: `HTTP ${res.status}` } }
    }
    return json
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postDimOrgHierRebuild(params?: {
  statYears?: number[]
  dryRun?: boolean
}): Promise<{ ok: boolean; dry_run?: boolean; rows_affected?: number; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/dim/org-hier/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stat_years: params?.statYears,
        dry_run: Boolean(params?.dryRun),
      }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    return json
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchAuditedEnterpriseRelationTree(
  params: {
    snapshotYear?: string
    mode: 'management' | 'equity'
    stateInvestor?: string
    keyword?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  snapshot_years?: string[]
  selected_year?: string
  nodes?: AuditedEnterpriseRelationTreeNode[]
  empty_hint?: string
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  if (params.snapshotYear?.trim()) sp.set('snapshot_year', params.snapshotYear.trim())
  sp.set('mode', params.mode)
  if (params.stateInvestor?.trim()) sp.set('state_investor', params.stateInvestor.trim())
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  try {
    const res = await apiFetch(`/api/dim/audited-enterprise/relation-tree?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const nodes = Array.isArray(json.nodes) ? (json.nodes as AuditedEnterpriseRelationTreeNode[]) : []
    const snapshot_years = Array.isArray(json.snapshot_years)
      ? json.snapshot_years.map((x: unknown) => String(x))
      : []
    return {
      ok: true,
      snapshot_years,
      selected_year: json.selected_year != null ? String(json.selected_year) : params.snapshotYear,
      nodes,
      empty_hint: json.empty_hint != null ? String(json.empty_hint) : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type AuditedEnterpriseRelationListRow = {
  name: string
  code: string
  snapshot_year: string
  state_investor_enterprise: string
  mgmt_path: string
  equity_path: string
  relation_type: string
  entity_id?: string
  subject_id?: string
  has_buyer_role?: boolean
  has_seller_role?: boolean
  invoice_count?: number
  role_label?: string
  match_status?: string
  match_key?: string
  subject_no?: string
  subject_name?: string
  in_roster?: boolean
  in_analysis_pool?: boolean
}

export type AuditedEnterpriseRelationKpis = {
  total: number
  relation_mismatch: number
  mapped: number
  unmapped: number
  in_analysis_pool: number
}

export type DimCaliberVersionDto = {
  id: string
  statYear: string
  versionNo: number
  status: 'draft' | 'published' | 'archived'
  isCurrent: boolean
  ruleVersion: string
  batchStart: string
  batchEnd: string
  includeExternalImport: boolean
  externalImportBatchCount: number
  changeNote: string
  updatedAt: string
  updatedBy: string
  publishedAt?: string | null
  publishedBy?: string | null
  kpis: {
    subjectTotal: number
    enterpriseRatio: number
    mappingCoverage: number
    unmatchedCount: number
  }
}

export async function fetchDimCaliberVersions(signal?: AbortSignal): Promise<{
  ok: boolean
  versions?: DimCaliberVersionDto[]
  stat_years?: string[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dim/caliber-versions', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const versions = Array.isArray(json.versions) ? (json.versions as DimCaliberVersionDto[]) : []
    const stat_years = Array.isArray(json.stat_years) ? json.stat_years.map(String) : []
    return { ok: true, versions, stat_years }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, error: { message: 'aborted' } }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

async function postDimCaliberVersionAction(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; version?: DimCaliberVersionDto; error?: { message?: string } }> {
  try {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return { ok: true, version: json.version as DimCaliberVersionDto | undefined }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export function postDimCaliberVersionCreateDraft(statYear: string) {
  return postDimCaliberVersionAction('/api/dim/caliber-versions/create-draft', { stat_year: statYear })
}

export function postDimCaliberVersionPublish(versionId: string) {
  return postDimCaliberVersionAction('/api/dim/caliber-versions/publish', { version_id: versionId })
}

export function postDimCaliberVersionRollback(versionId: string) {
  return postDimCaliberVersionAction('/api/dim/caliber-versions/rollback', { version_id: versionId })
}

export function postDimCaliberVersionArchive(versionId: string) {
  return postDimCaliberVersionAction('/api/dim/caliber-versions/archive', { version_id: versionId })
}

export function postDimCaliberVersionSaveDraft(versionId: string) {
  return postDimCaliberVersionAction('/api/dim/caliber-versions/save-draft', { version_id: versionId })
}

export async function fetchAuditedEnterpriseRelationRows(
  params: {
    snapshotYear?: string
    stateInvestor?: string
    keyword?: string
    page?: number
    pageSize?: number
    sort?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  snapshot_years?: string[]
  selected_year?: string
  total?: number
  page?: number
  page_size?: number
  rows?: AuditedEnterpriseRelationListRow[]
  kpis?: AuditedEnterpriseRelationKpis
  empty_hint?: string
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  if (params.snapshotYear?.trim()) sp.set('snapshot_year', params.snapshotYear.trim())
  if (params.stateInvestor?.trim()) sp.set('state_investor', params.stateInvestor.trim())
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  sp.set('page', String(params.page ?? 1))
  sp.set('page_size', String(params.pageSize ?? 50))
  if (params.sort?.trim()) sp.set('sort', params.sort.trim())
  try {
    const res = await apiFetch(`/api/dim/audited-enterprise/relation-rows?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const rows = Array.isArray(json.rows) ? (json.rows as AuditedEnterpriseRelationListRow[]) : []
    const snapshot_years = Array.isArray(json.snapshot_years)
      ? json.snapshot_years.map((x: unknown) => String(x))
      : []
    const kpisRaw = json.kpis
    const kpis: AuditedEnterpriseRelationKpis | undefined =
      kpisRaw && typeof kpisRaw === 'object'
        ? {
            total: Number(kpisRaw.total ?? 0),
            relation_mismatch: Number(kpisRaw.relation_mismatch ?? 0),
            mapped: Number(kpisRaw.mapped ?? 0),
            unmapped: Number(kpisRaw.unmapped ?? 0),
            in_analysis_pool: Number(kpisRaw.in_analysis_pool ?? 0),
          }
        : undefined
    return {
      ok: true,
      snapshot_years,
      selected_year: json.selected_year != null ? String(json.selected_year) : params.snapshotYear,
      total: json.total != null ? Number(json.total) : rows.length,
      page: json.page != null ? Number(json.page) : params.page,
      page_size: json.page_size != null ? Number(json.page_size) : params.pageSize,
      rows,
      kpis,
      empty_hint: json.empty_hint != null ? String(json.empty_hint) : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** 发票报送覆盖分析（DuckDB vw_audit_invoice_coverage_*） */
export type InvoiceCoverageSoeOption = {
  soe_anchor_enterprise_id: string
  soe_anchor_enterprise_name: string
}

export type InvoiceCoverageMemberRow = {
  enterprise_id: string
  enterprise_name: string
  norm_enterprise_id: string
  level1_group_id: string
  level1_group_name: string
  soe_anchor_enterprise_id: string
  soe_anchor_enterprise_name: string
  soe_anchor_source: string
  subject_id: string | null
  is_reported_both: boolean
  in_coverage_denominator: boolean
  has_seller_role: boolean
  has_buyer_role: boolean
  role_tag: string
  mgmt_level: number | null
  mgmt_parent_enterprise_name: string
  equity_level: number | null
  equity_parent_enterprise_name: string
  year_last_seen_batch_id: string
}

export async function fetchInvoiceCoverageMeta(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  views_ready?: boolean
  stat_years?: string[]
  default_stat_year?: string | null
  group_member_stat_years?: string[]
  roster_stat_years?: string[]
  level1_stat_years?: string[]
  mapping_status_ready?: boolean
  hint?: string
  error?: { message?: string; exception_type?: string }
}> {
  try {
    const res = await apiFetch('/api/invoice-coverage/meta', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const toYearList = (key: string) =>
      Array.isArray(json[key]) ? json[key].map((x: unknown) => String(x)) : []
    return {
      ok: true,
      views_ready: Boolean(json.views_ready),
      stat_years: toYearList('stat_years'),
      default_stat_year: json.default_stat_year != null ? String(json.default_stat_year) : null,
      group_member_stat_years: toYearList('group_member_stat_years'),
      roster_stat_years: toYearList('roster_stat_years').length
        ? toYearList('roster_stat_years')
        : toYearList('group_member_stat_years'),
      level1_stat_years: toYearList('level1_stat_years'),
      mapping_status_ready: Boolean(json.mapping_status_ready),
      hint: json.hint != null ? String(json.hint) : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchInvoiceCoverageSoeOptions(
  statYear: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; aborted?: boolean; options?: InvoiceCoverageSoeOption[]; error?: { message?: string } }> {
  const sp = new URLSearchParams()
  sp.set('stat_year', statYear.trim())
  try {
    const res = await apiFetch(`/api/invoice-coverage/soe-options?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const raw = Array.isArray(json.options) ? json.options : []
    const options: InvoiceCoverageSoeOption[] = raw.map((x: any) => ({
      soe_anchor_enterprise_id: String(x?.soe_anchor_enterprise_id ?? ''),
      soe_anchor_enterprise_name: String(x?.soe_anchor_enterprise_name ?? ''),
    }))
    return { ok: true, options }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchInvoiceCoverageSummary(
  params: {
    statYear: string
    soeAnchorId?: string
    soeAnchorKw?: string
    level1GroupKw?: string
    enterpriseKw?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  views_ready?: boolean
  stat_year?: string
  member_row_count?: number
  denominator_mapped_members?: number
  reported_both_members?: number
  unmapped_member_rows?: number
  coverage_ratio?: number | null
  error?: { message?: string; exception_type?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.soeAnchorId?.trim()) sp.set('soe_anchor_id', params.soeAnchorId.trim())
  if (params.soeAnchorKw?.trim()) sp.set('soe_anchor_kw', params.soeAnchorKw.trim())
  if (params.level1GroupKw?.trim()) sp.set('level1_group_kw', params.level1GroupKw.trim())
  if (params.enterpriseKw?.trim()) sp.set('enterprise_kw', params.enterpriseKw.trim())
  try {
    const res = await apiFetch(`/api/invoice-coverage/summary?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      views_ready: Boolean(json.views_ready),
      stat_year: json.stat_year != null ? String(json.stat_year) : params.statYear,
      member_row_count: Number(json.member_row_count ?? 0),
      denominator_mapped_members: Number(json.denominator_mapped_members ?? 0),
      reported_both_members: Number(json.reported_both_members ?? 0),
      unmapped_member_rows: Number(json.unmapped_member_rows ?? 0),
      coverage_ratio: json.coverage_ratio === null || json.coverage_ratio === undefined ? null : Number(json.coverage_ratio),
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchInvoiceCoverageMembers(
  params: {
    statYear: string
    listView: 'unreported' | 'reported' | 'all' | 'unmapped'
    soeAnchorId?: string
    soeAnchorKw?: string
    level1GroupKw?: string
    enterpriseKw?: string
    limit?: number
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  views_ready?: boolean
  rows?: InvoiceCoverageMemberRow[]
  total?: number
  limit?: number
  error?: { message?: string; exception_type?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('list_view', params.listView)
  if (params.soeAnchorId?.trim()) sp.set('soe_anchor_id', params.soeAnchorId.trim())
  if (params.soeAnchorKw?.trim()) sp.set('soe_anchor_kw', params.soeAnchorKw.trim())
  if (params.level1GroupKw?.trim()) sp.set('level1_group_kw', params.level1GroupKw.trim())
  if (params.enterpriseKw?.trim()) sp.set('enterprise_kw', params.enterpriseKw.trim())
  if (params.limit != null && Number.isFinite(params.limit)) sp.set('limit', String(Math.floor(params.limit)))
  try {
    const res = await apiFetch(`/api/invoice-coverage/members?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const raw = Array.isArray(json.rows) ? json.rows : []
    const rows: InvoiceCoverageMemberRow[] = raw.map((x: any) => ({
      enterprise_id: String(x?.enterprise_id ?? ''),
      enterprise_name: String(x?.enterprise_name ?? ''),
      norm_enterprise_id: String(x?.norm_enterprise_id ?? ''),
      level1_group_id: String(x?.level1_group_id ?? ''),
      level1_group_name: String(x?.level1_group_name ?? ''),
      soe_anchor_enterprise_id: String(x?.soe_anchor_enterprise_id ?? ''),
      soe_anchor_enterprise_name: String(x?.soe_anchor_enterprise_name ?? ''),
      soe_anchor_source: String(x?.soe_anchor_source ?? ''),
      subject_id: x?.subject_id != null && x.subject_id !== '' ? String(x.subject_id) : null,
      is_reported_both: Boolean(x?.is_reported_both),
      in_coverage_denominator: Boolean(x?.in_coverage_denominator),
      has_seller_role: Boolean(x?.has_seller_role),
      has_buyer_role: Boolean(x?.has_buyer_role),
      role_tag: String(x?.role_tag ?? 'unknown'),
      mgmt_level: x?.mgmt_level != null && x.mgmt_level !== '' ? Number(x.mgmt_level) : null,
      mgmt_parent_enterprise_name: String(x?.mgmt_parent_enterprise_name ?? ''),
      equity_level: x?.equity_level != null && x.equity_level !== '' ? Number(x.equity_level) : null,
      equity_parent_enterprise_name: String(x?.equity_parent_enterprise_name ?? ''),
      year_last_seen_batch_id: String(x?.year_last_seen_batch_id ?? ''),
    }))
    return {
      ok: true,
      views_ready: Boolean(json.views_ready),
      rows,
      total: Number(json.total ?? 0),
      limit: Number(json.limit ?? 0),
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type InvoiceCoverageMappingStatusRow = {
  taxpayer_id: string
  enterprise_name_raw: string
  enterprise_name_std: string
  linked_enterprise_id: string
  linked_taxpayer_id: string
  match_key: string
  match_status: string
  match_status_label: string
  pending_reason: string
  pending_reason_label: string
  import_batch_id: string
  calc_run_id: string
  calc_time: string
}

export async function fetchInvoiceCoverageMappingStatus(
  params: {
    statYear: string
    enterpriseKw?: string
    matchStatus?: 'pending' | 'name_fallback' | 'matched' | 'all'
    limit?: number
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  mapping_status_ready?: boolean
  calc_run_id?: string
  hint?: string
  rows?: InvoiceCoverageMappingStatusRow[]
  total?: number
  limit?: number
  error?: { message?: string; exception_type?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('match_status', params.matchStatus ?? 'pending')
  if (params.enterpriseKw?.trim()) sp.set('enterprise_kw', params.enterpriseKw.trim())
  if (params.limit != null && Number.isFinite(params.limit)) sp.set('limit', String(Math.floor(params.limit)))
  try {
    const res = await apiFetch(`/api/invoice-coverage/mapping-status?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const raw = Array.isArray(json.rows) ? json.rows : []
    const rows: InvoiceCoverageMappingStatusRow[] = raw.map((x: any) => ({
      taxpayer_id: String(x?.taxpayer_id ?? ''),
      enterprise_name_raw: String(x?.enterprise_name_raw ?? ''),
      enterprise_name_std: String(x?.enterprise_name_std ?? ''),
      linked_enterprise_id: String(x?.linked_enterprise_id ?? ''),
      linked_taxpayer_id: String(x?.linked_taxpayer_id ?? ''),
      match_key: String(x?.match_key ?? ''),
      match_status: String(x?.match_status ?? ''),
      match_status_label: String(x?.match_status_label ?? ''),
      pending_reason: String(x?.pending_reason ?? ''),
      pending_reason_label: String(x?.pending_reason_label ?? ''),
      import_batch_id: String(x?.import_batch_id ?? ''),
      calc_run_id: String(x?.calc_run_id ?? ''),
      calc_time: String(x?.calc_time ?? ''),
    }))
    return {
      ok: true,
      mapping_status_ready: Boolean(json.mapping_status_ready),
      calc_run_id: json.calc_run_id != null ? String(json.calc_run_id) : undefined,
      hint: json.hint != null ? String(json.hint) : undefined,
      rows,
      total: Number(json.total ?? 0),
      limit: Number(json.limit ?? 0),
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** DWS 看板（dws_inv_trend / dws_sup_conc 等） */
export type DwsEntityOption = {
  entity_id: string
  entity_name: string
  total_net_jshj: number
}

export type DwsTrendRow = {
  stat_month: number
  role_type: string
  net_jshj: number
  invoice_cnt: number
}

export type DwsSupplierTopRow = {
  supplier_id: string
  supplier_name: string
  net_jshj: number
  invoice_cnt: number
  amount_rank: number
  amount_ratio: number
  cumulative_ratio: number
  is_new_supplier: boolean
  first_invoice_date: string
  last_invoice_date: string
}

export type AnalysisSubjectEntityOption = DwsEntityOption & {
  has_seller_role?: boolean
  has_buyer_role?: boolean
  invoice_count?: number
}

export type DwsSupplierChurnRow = {
  supplier_id: string
  supplier_name: string
  net_jshj: number
  invoice_cnt: number
  amount_rank: number
  amount_ratio: number
  cumulative_ratio: number
  first_invoice_date: string
  last_invoice_date: string
  is_top10: boolean
  churn_kind: 'new' | 'disappeared'
  compare_year?: number
}

export async function fetchDwsMeta(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  stat_years?: string[]
  default_stat_year?: string
  dws_ready?: boolean
  hint?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/dws/meta', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      stat_years: Array.isArray(json.stat_years) ? json.stat_years.map(String) : [],
      default_stat_year: json.default_stat_year != null ? String(json.default_stat_year) : undefined,
      dws_ready: Boolean(json.dws_ready),
      hint: json.hint != null ? String(json.hint) : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsEntityOptions(
  statYear: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; aborted?: boolean; options?: DwsEntityOption[]; error?: { message?: string } }> {
  const sp = new URLSearchParams()
  sp.set('stat_year', statYear.trim())
  try {
    const res = await apiFetch(`/api/dws/entity-options?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const options: DwsEntityOption[] = (json.options ?? []).map((x: any) => ({
      entity_id: String(x?.entity_id ?? ''),
      entity_name: String(x?.entity_name ?? ''),
      total_net_jshj: Number(x?.total_net_jshj ?? 0),
    }))
    return { ok: true, options }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchAnalysisSubjectMeta(
  params?: { minInvoiceCount?: number },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  min_invoice_count?: number
  comparison?: string
  caliber_hint?: string
  hint?: string
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  if (params?.minInvoiceCount != null && Number.isFinite(params.minInvoiceCount)) {
    sp.set('min_invoice_count', String(Math.trunc(params.minInvoiceCount)))
  }
  const qs = sp.toString()
  try {
    const res = await apiFetch(`/api/dws/analysis-subject/meta${qs ? `?${qs}` : ''}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      min_invoice_count: Number(json.min_invoice_count ?? 10),
      comparison: String(json.comparison ?? '>='),
      caliber_hint: json.caliber_hint != null ? String(json.caliber_hint) : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchAnalysisSubjectOptions(
  params: {
    statYear: string
    requireBuyer?: boolean
    requireBothRoles?: boolean
    minInvoiceCount?: number
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  options?: AnalysisSubjectEntityOption[]
  min_invoice_count?: number
  hint?: string
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.requireBuyer) sp.set('require_buyer', '1')
  if (params.requireBothRoles) sp.set('require_both_roles', '1')
  if (params.minInvoiceCount != null && Number.isFinite(params.minInvoiceCount)) {
    sp.set('min_invoice_count', String(Math.trunc(params.minInvoiceCount)))
  }
  try {
    const res = await apiFetch(`/api/dws/analysis-subject/options?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const options: AnalysisSubjectEntityOption[] = (json.options ?? []).map((x: any) => ({
      entity_id: String(x?.entity_id ?? ''),
      entity_name: String(x?.entity_name ?? ''),
      total_net_jshj: Number(x?.total_net_jshj ?? x?.amount_jshj_sum ?? 0),
      has_seller_role: Boolean(x?.has_seller_role),
      has_buyer_role: Boolean(x?.has_buyer_role),
      invoice_count: Number(x?.invoice_count ?? 0),
    }))
    return {
      ok: true,
      options,
      min_invoice_count: Number(json.min_invoice_count ?? 10),
      hint: json.hint != null ? String(json.hint) : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsOverviewSummary(
  params: {
    statYear: string
    entityId?: string
    statMonth?: string
    dateFrom?: string
    dateTo?: string
  },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.entityId?.trim()) sp.set('entity_id', params.entityId.trim())
  if (params.statMonth?.trim()) sp.set('stat_month', params.statMonth.trim())
  if (params.dateFrom?.trim()) sp.set('date_from', params.dateFrom.trim())
  if (params.dateTo?.trim()) sp.set('date_to', params.dateTo.trim())
  try {
    const res = await apiFetch(`/api/dws/overview/summary?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      total_net_jshj: Number(json.total_net_jshj ?? 0),
      invoice_cnt: Number(json.invoice_cnt ?? 0),
      output_net_jshj: Number(json.output_net_jshj ?? 0),
      input_net_jshj: Number(json.input_net_jshj ?? 0),
      supplier_cnt: Number(json.supplier_cnt ?? 0),
      quality_issue_cnt: Number(json.quality_issue_cnt ?? 0),
      avg_quality_score: Number(json.avg_quality_score ?? 0),
      red_cnt: Number(json.red_cnt ?? 0),
      cancel_cnt: Number(json.cancel_cnt ?? 0),
      supplier_cnt_source: json.supplier_cnt_source as string | undefined,
      quality_metrics_source: json.quality_metrics_source as string | undefined,
      filter_stat_month: json.filter_stat_month as number | undefined,
      filter_date_from: json.filter_date_from as string | undefined,
      filter_date_to: json.filter_date_to as string | undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true, error: { message: e instanceof Error ? e.message : '网络错误' } }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsOverviewTrend(
  params: {
    statYear: string
    entityId?: string
    roleType?: string
    statMonth?: string
    dateFrom?: string
    dateTo?: string
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; aborted?: boolean; rows?: DwsTrendRow[]; error?: { message?: string } }> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.entityId?.trim()) sp.set('entity_id', params.entityId.trim())
  if (params.roleType && params.roleType !== 'all') sp.set('role_type', params.roleType)
  if (params.statMonth?.trim()) sp.set('stat_month', params.statMonth.trim())
  if (params.dateFrom?.trim()) sp.set('date_from', params.dateFrom.trim())
  if (params.dateTo?.trim()) sp.set('date_to', params.dateTo.trim())
  try {
    const res = await apiFetch(`/api/dws/overview/trend?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const rows: DwsTrendRow[] = (json.rows ?? []).map((x: any) => ({
      stat_month: Number(x?.stat_month ?? 0),
      role_type: String(x?.role_type ?? ''),
      net_jshj: Number(x?.net_jshj ?? 0),
      invoice_cnt: Number(x?.invoice_cnt ?? 0),
    }))
    return { ok: true, rows }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsSupplierCr(
  params: {
    statYear: string
    entityId: string
    statMonth?: string
    dateFrom?: string
    dateTo?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  cr1?: number | null
  cr3?: number | null
  cr10?: number | null
  supplier_cnt?: number
  total_net_jshj?: number
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  if (params.statMonth?.trim()) sp.set('stat_month', params.statMonth.trim())
  if (params.dateFrom?.trim()) sp.set('date_from', params.dateFrom.trim())
  if (params.dateTo?.trim()) sp.set('date_to', params.dateTo.trim())
  try {
    const res = await apiFetch(`/api/dws/supplier/cr?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      cr1: json.cr1 != null ? Number(json.cr1) : null,
      cr3: json.cr3 != null ? Number(json.cr3) : null,
      cr10: json.cr10 != null ? Number(json.cr10) : null,
      supplier_cnt: Number(json.supplier_cnt ?? 0),
      total_net_jshj: Number(json.total_net_jshj ?? 0),
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDwsSupplierTop(
  params: {
    statYear: string
    entityId: string
    limit?: number
    statMonth?: string
    dateFrom?: string
    dateTo?: string
    quarter?: string
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; aborted?: boolean; rows?: DwsSupplierTopRow[]; total?: number; error?: { message?: string } }> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.statMonth?.trim()) sp.set('stat_month', params.statMonth.trim())
  if (params.quarter?.trim()) sp.set('quarter', params.quarter.trim())
  if (params.dateFrom?.trim()) sp.set('date_from', params.dateFrom.trim())
  if (params.dateTo?.trim()) sp.set('date_to', params.dateTo.trim())
  try {
    const res = await apiFetch(`/api/dws/supplier/top?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const rows: DwsSupplierTopRow[] = (json.rows ?? []).map((x: any) => ({
      supplier_id: String(x?.supplier_id ?? ''),
      supplier_name: String(x?.supplier_name ?? ''),
      net_jshj: Number(x?.net_jshj ?? 0),
      invoice_cnt: Number(x?.invoice_cnt ?? 0),
      amount_rank: Number(x?.amount_rank ?? 0),
      amount_ratio: Number(x?.amount_ratio ?? 0),
      cumulative_ratio: Number(x?.cumulative_ratio ?? 0),
      is_new_supplier: Boolean(x?.is_new_supplier),
      first_invoice_date: String(x?.first_invoice_date ?? ''),
      last_invoice_date: String(x?.last_invoice_date ?? ''),
    }))
    return { ok: true, rows, total: Number(json.total ?? 0) }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DwsEntityProfile = {
  stat_year: string
  entity_id: string
  entity_name: string
  concentration: {
    cr1: number | null
    cr3: number | null
    cr10: number | null
    total_net_jshj: number | null
    top_suppliers: DwsSupplierTopRow[]
  }
  churn: {
    new_total: number
    new_top10: number
    disappeared_total: number
    prior_year: string
  }
  tax_structure: {
    buckets: Array<{ tax_bucket: string; amount_je: number; line_cnt: number; amount_ratio: number }>
    total_amount_je: number | null
    total_line_cnt: number | null
  }
  tax_code: Partial<TaxCodeFluctuation> & {
    match_rate?: number | null
    high_risk_amount_share?: number | null
    top_category_name?: string | null
    top_category_share?: number | null
  }
  related: {
    graph_node_count: number
    graph_edge_count: number
    graph_ok: boolean
  }
  audit_flags: {
    total: number
    pending: number
    by_rule: Array<{
      rule_id: string
      flag_count: number
      pending_count: number
      amount_sum: number
    }>
  }
  customer_concentration?: {
    cr1: number | null
    cr3: number | null
    cr10: number | null
    total_net_jshj: number | null
    top_customers: DwsCustomerTopRow[]
  }
  behavior?: { summary: Record<string, number>; month_count: number }
  goods_category?: {
    total_net_jshj: number | null
    top_categories: DwsGoodsCatRow[]
  }
  counterparty_risk?: { rows: DwsCounterpartyRiskRow[] }
  year_over_year?: {
    prior_year: string
    churn_summary: { new_total?: number; disappeared_total?: number }
    tax_buckets: { current?: TaxBucketRow[]; prior?: TaxBucketRow[] }
  }
}

type TaxBucketRow = { tax_bucket: string; amount_ratio: number; amount_je: number }

export type DwsGoodsCatRow = {
  tax_code_short: string
  tax_code_level2: string
  stat_quarter: number
  net_jshj: number
  invoice_cnt: number
  supplier_cnt: number
  avg_single_amt: number | null
  max_single_amt: number | null
  distinct_tax_rates: number
}

export type DwsCustomerTopRow = {
  customer_id: string
  customer_name: string
  net_jshj: number
  invoice_cnt: number
  amount_rank: number
  amount_ratio: number
  cumulative_ratio: number
  is_new_customer: boolean
  last_invoice_date: string
}

export type DwsEnterpriseBehaviorMonth = {
  stat_month: string
  stat_month_no: number
  inv_cnt_total: number
  inv_amt_total: number
  red_inv_ratio: number | null
  amt_mom_change: number | null
  cnt_mom_change: number | null
  abnormal_red_flag: boolean
  abnormal_spike_flag: boolean
  abnormal_counterparty_concentration_flag: boolean
  risk_level: string
}

export type DwsRedOffsetOverview = {
  stat_year: string
  entity_id: string | null
  kpis: {
    header_cnt: number
    red_cnt: number
    red_ratio: number | null
    orphan_cnt: number
    fully_reversed_cnt: number
    red_offset_amt: number
    net_amt: number
  }
  monthly_trend: Array<{ stat_month: number; header_cnt: number; red_cnt: number; orphan_cnt: number }>
  hint?: string | null
}

export type DwsRedOffsetRow = {
  invoice_no: string
  invoice_date: string
  seller_tax_no: string
  seller_name: string
  buyer_tax_no: string
  buyer_name: string
  fpzt: string
  net_calc_status: string
  is_fully_reversed: boolean
  is_orphan_red: boolean
  red_offset_jshj: number
  net_jshj: number
  red_invoice_count: number
}

export type DwsInvoiceTimingOverview = {
  stat_year: string
  entity_id: string
  role_type: string
  stats: {
    holiday_cnt: number
    weekend_large_cnt: number
    normal_cnt: number
    yearend_cnt: number
    yearend_ratio: number | null
  }
  day_of_week: Array<{ dow: number; cnt: number }>
  monthly: Array<{ stat_month: number; holiday_cnt: number; weekend_large_cnt: number }>
  hint?: string | null
}

export type DwsCounterpartyRiskRow = {
  counterparty_id: string
  counterparty_name: string
  trade_amount: number
  flag_count: number
  amount_sum: number
  by_rule: Record<string, number>
  risk_score: number
}

export type DwsYearOverYearCompare = {
  stat_year: string
  prior_year: string
  entity_id: string
  tax_buckets: { current: TaxBucketRow[]; prior: TaxBucketRow[] }
  top_suppliers: { current: DwsSupplierTopRow[]; prior: DwsSupplierTopRow[] }
  top_customers: { current: Array<{ id: string; name: string; amount: number }>; prior: Array<{ id: string; name: string; amount: number }> }
  category_mix: { current: Array<{ id: string; name: string; amount: number }>; prior: Array<{ id: string; name: string; amount: number }> }
  churn_summary: { new_total: number; disappeared_total: number }
}

export async function fetchDwsEntityProfile(
  params: { statYear: string; entityId: string; minInvoiceCount?: number },
  signal?: AbortSignal,
): Promise<{ ok: boolean; aborted?: boolean; data?: DwsEntityProfile; error?: { message?: string } }> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  if (params.minInvoiceCount != null && Number.isFinite(params.minInvoiceCount)) {
    sp.set('min_invoice_count', String(Math.trunc(params.minInvoiceCount)))
  }
  try {
    const res = await apiFetch(`/api/dws/entity-profile?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const topSuppliers: DwsSupplierTopRow[] = (json.concentration?.top_suppliers ?? []).map((x: any) => ({
      supplier_id: String(x?.supplier_id ?? ''),
      supplier_name: String(x?.supplier_name ?? ''),
      net_jshj: Number(x?.net_jshj ?? 0),
      invoice_cnt: Number(x?.invoice_cnt ?? 0),
      amount_rank: Number(x?.amount_rank ?? 0),
      amount_ratio: Number(x?.amount_ratio ?? 0),
      cumulative_ratio: Number(x?.cumulative_ratio ?? 0),
      is_new_supplier: Boolean(x?.is_new_supplier),
      first_invoice_date: String(x?.first_invoice_date ?? ''),
      last_invoice_date: String(x?.last_invoice_date ?? ''),
    }))
    return {
      ok: true,
      data: {
        stat_year: String(json.stat_year ?? params.statYear),
        entity_id: String(json.entity_id ?? params.entityId),
        entity_name: String(json.entity_name ?? params.entityId),
        concentration: {
          cr1: json.concentration?.cr1 != null ? Number(json.concentration.cr1) : null,
          cr3: json.concentration?.cr3 != null ? Number(json.concentration.cr3) : null,
          cr10: json.concentration?.cr10 != null ? Number(json.concentration.cr10) : null,
          total_net_jshj:
            json.concentration?.total_net_jshj != null ? Number(json.concentration.total_net_jshj) : null,
          top_suppliers: topSuppliers,
        },
        churn: {
          new_total: Number(json.churn?.new_total ?? 0),
          new_top10: Number(json.churn?.new_top10 ?? 0),
          disappeared_total: Number(json.churn?.disappeared_total ?? 0),
          prior_year: String(json.churn?.prior_year ?? ''),
        },
        tax_structure: {
          buckets: (json.tax_structure?.buckets ?? []).map((b: any) => ({
            tax_bucket: String(b?.tax_bucket ?? ''),
            amount_je: Number(b?.amount_je ?? 0),
            line_cnt: Number(b?.line_cnt ?? 0),
            amount_ratio: Number(b?.amount_ratio ?? 0),
          })),
          total_amount_je:
            json.tax_structure?.total_amount_je != null ? Number(json.tax_structure.total_amount_je) : null,
          total_line_cnt:
            json.tax_structure?.total_line_cnt != null ? Number(json.tax_structure.total_line_cnt) : null,
        },
        tax_code: {
          match_rate: json.tax_code?.match_rate != null ? Number(json.tax_code.match_rate) : null,
          high_risk_amount_share:
            json.tax_code?.high_risk_amount_share != null ? Number(json.tax_code.high_risk_amount_share) : null,
          top_category_name:
            json.tax_code?.top_category_name != null ? String(json.tax_code.top_category_name) : null,
          top_category_share:
            json.tax_code?.top_category_share != null ? Number(json.tax_code.top_category_share) : null,
          fluctuation_index:
            json.tax_code?.fluctuation_index != null ? Number(json.tax_code.fluctuation_index) : null,
          fluctuation_level:
            json.tax_code?.fluctuation_level === 'low' ||
            json.tax_code?.fluctuation_level === 'medium' ||
            json.tax_code?.fluctuation_level === 'high'
              ? json.tax_code.fluctuation_level
              : null,
          baseline_month:
            json.tax_code?.baseline_month != null ? Number(json.tax_code.baseline_month) : null,
          compare_month: json.tax_code?.compare_month != null ? Number(json.tax_code.compare_month) : null,
          top_movers: Array.isArray(json.tax_code?.top_movers)
            ? json.tax_code.top_movers.map((m: any) => ({
                category_prefix: String(m?.category_prefix ?? ''),
                baseline_share: Number(m?.baseline_share ?? 0),
                compare_share: Number(m?.compare_share ?? 0),
                delta_share: Number(m?.delta_share ?? 0),
              }))
            : [],
        },
        related: {
          graph_node_count: Number(json.related?.graph_node_count ?? 0),
          graph_edge_count: Number(json.related?.graph_edge_count ?? 0),
          graph_ok: Boolean(json.related?.graph_ok),
        },
        audit_flags: {
          total: Number(json.audit_flags?.total ?? 0),
          pending: Number(json.audit_flags?.pending ?? 0),
          by_rule: (json.audit_flags?.by_rule ?? []).map((r: any) => ({
            rule_id: String(r?.rule_id ?? ''),
            flag_count: Number(r?.flag_count ?? 0),
            pending_count: Number(r?.pending_count ?? 0),
            amount_sum: Number(r?.amount_sum ?? 0),
          })),
        },
        customer_concentration: json.customer_concentration
          ? {
              cr1: json.customer_concentration.cr1 != null ? Number(json.customer_concentration.cr1) : null,
              cr3: json.customer_concentration.cr3 != null ? Number(json.customer_concentration.cr3) : null,
              cr10: json.customer_concentration.cr10 != null ? Number(json.customer_concentration.cr10) : null,
              total_net_jshj:
                json.customer_concentration.total_net_jshj != null
                  ? Number(json.customer_concentration.total_net_jshj)
                  : null,
              top_customers: (json.customer_concentration.top_customers ?? []).map((x: any) => ({
                customer_id: String(x?.customer_id ?? ''),
                customer_name: String(x?.customer_name ?? ''),
                net_jshj: Number(x?.net_jshj ?? 0),
                invoice_cnt: Number(x?.invoice_cnt ?? 0),
                amount_rank: Number(x?.amount_rank ?? 0),
                amount_ratio: Number(x?.amount_ratio ?? 0),
                cumulative_ratio: Number(x?.cumulative_ratio ?? 0),
                is_new_customer: Boolean(x?.is_new_customer),
                last_invoice_date: String(x?.last_invoice_date ?? ''),
              })),
            }
          : undefined,
        behavior: json.behavior
          ? {
              summary: json.behavior.summary ?? {},
              month_count: Number(json.behavior.month_count ?? 0),
            }
          : undefined,
        goods_category: json.goods_category
          ? {
              total_net_jshj:
                json.goods_category.total_net_jshj != null ? Number(json.goods_category.total_net_jshj) : null,
              top_categories: (json.goods_category.top_categories ?? []).map((x: any) => ({
                tax_code_short: String(x?.tax_code_short ?? ''),
                tax_code_level2: String(x?.tax_code_level2 ?? ''),
                stat_quarter: Number(x?.stat_quarter ?? 0),
                net_jshj: Number(x?.net_jshj ?? 0),
                invoice_cnt: Number(x?.invoice_cnt ?? 0),
                supplier_cnt: Number(x?.supplier_cnt ?? 0),
                avg_single_amt: x?.avg_single_amt != null ? Number(x.avg_single_amt) : null,
                max_single_amt: x?.max_single_amt != null ? Number(x.max_single_amt) : null,
                distinct_tax_rates: Number(x?.distinct_tax_rates ?? 0),
              })),
            }
          : undefined,
        counterparty_risk: json.counterparty_risk
          ? {
              rows: (json.counterparty_risk.rows ?? []).map((x: any) => ({
                counterparty_id: String(x?.counterparty_id ?? ''),
                counterparty_name: String(x?.counterparty_name ?? ''),
                trade_amount: Number(x?.trade_amount ?? 0),
                flag_count: Number(x?.flag_count ?? 0),
                amount_sum: Number(x?.amount_sum ?? 0),
                by_rule: x?.by_rule ?? {},
                risk_score: Number(x?.risk_score ?? 0),
              })),
            }
          : undefined,
        year_over_year: json.year_over_year
          ? {
              prior_year: String(json.year_over_year.prior_year ?? ''),
              churn_summary: json.year_over_year.churn_summary ?? {},
              tax_buckets: json.year_over_year.tax_buckets ?? {},
            }
          : undefined,
      },
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DwsInvoiceDetailRow = {
  sdfphm: string
  fpdm: string
  fphm: string
  kprq: string
  fpzt: string
  xfmc: string
  xfsbh: string
  gfmc: string
  gfsbh: string
  hwlwmc: string
  ssflbm: string
  je: number
  se: number
  jshj: number
  slv: string
  slv_num: number | null
  stat_year: number | null
  stat_month: number | null
  logic_line_no: number
}

export type DwsInvoiceDetailFilters = {
  statYear: string
  entityId?: string
  statMonth?: string
  dateFrom?: string
  dateTo?: string
  sellerTaxNo?: string
  goodsName?: string
  slvNum?: string
}

function buildInvoiceDetailQuery(params: DwsInvoiceDetailFilters & { limit?: number; offset?: number }) {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  if (params.entityId?.trim()) sp.set('entity_id', params.entityId.trim())
  if (params.statMonth?.trim()) sp.set('stat_month', params.statMonth.trim())
  if (params.dateFrom?.trim()) sp.set('date_from', params.dateFrom.trim())
  if (params.dateTo?.trim()) sp.set('date_to', params.dateTo.trim())
  if (params.sellerTaxNo?.trim()) sp.set('seller_tax_no', params.sellerTaxNo.trim())
  if (params.goodsName?.trim()) sp.set('goods_name', params.goodsName.trim())
  if (params.slvNum?.trim()) sp.set('slv_num', params.slvNum.trim())
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  return sp
}

export async function fetchDwsInvoiceDetailList(
  params: DwsInvoiceDetailFilters & { limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  total?: number
  rows?: DwsInvoiceDetailRow[]
  error?: { message?: string }
}> {
  const sp = buildInvoiceDetailQuery(params)
  try {
    const res = await apiFetch(`/api/dws/invoice-detail/list?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const rows: DwsInvoiceDetailRow[] = (json.rows ?? []).map((x: any) => ({
      sdfphm: String(x?.sdfphm ?? ''),
      fpdm: String(x?.fpdm ?? ''),
      fphm: String(x?.fphm ?? ''),
      kprq: String(x?.kprq ?? ''),
      fpzt: String(x?.fpzt ?? ''),
      xfmc: String(x?.xfmc ?? ''),
      xfsbh: String(x?.xfsbh ?? ''),
      gfmc: String(x?.gfmc ?? ''),
      gfsbh: String(x?.gfsbh ?? ''),
      hwlwmc: String(x?.hwlwmc ?? ''),
      ssflbm: String(x?.ssflbm ?? ''),
      je: Number(x?.je ?? 0),
      se: Number(x?.se ?? 0),
      jshj: Number(x?.jshj ?? 0),
      slv: String(x?.slv ?? ''),
      slv_num: x?.slv_num != null ? Number(x.slv_num) : null,
      stat_year: x?.stat_year != null ? Number(x.stat_year) : null,
      stat_month: x?.stat_month != null ? Number(x.stat_month) : null,
      logic_line_no: Number(x?.logic_line_no ?? 0),
    }))
    return { ok: true, total: Number(json.total ?? 0), rows }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export function dwsInvoiceDetailExportUrl(params: DwsInvoiceDetailFilters): string {
  return apiUrl(`/api/dws/invoice-detail/export?${buildInvoiceDetailQuery(params).toString()}`)
}

export async function fetchDwsSupplierChurn(
  params: {
    statYear: string
    entityId: string
    kind?: 'new' | 'disappeared'
    topOnly?: boolean
    keyword?: string
    limit?: number
    offset?: number
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  rows?: DwsSupplierChurnRow[]
  total?: number
  prior_year?: string
  summary?: {
    new_total: number
    new_top10: number
    disappeared_total: number
    prior_year: string
  }
  hint?: string
  error?: { message?: string }
}> {
  const sp = new URLSearchParams()
  sp.set('stat_year', params.statYear.trim())
  sp.set('entity_id', params.entityId.trim())
  sp.set('kind', params.kind ?? 'new')
  if (params.topOnly) sp.set('top_only', '1')
  if (params.keyword?.trim()) sp.set('keyword', params.keyword.trim())
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  try {
    const res = await apiFetch(`/api/dws/supplier/churn?${sp.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const rows: DwsSupplierChurnRow[] = (json.rows ?? []).map((x: any) => ({
      supplier_id: String(x?.supplier_id ?? ''),
      supplier_name: String(x?.supplier_name ?? ''),
      net_jshj: Number(x?.net_jshj ?? 0),
      invoice_cnt: Number(x?.invoice_cnt ?? 0),
      amount_rank: Number(x?.amount_rank ?? 0),
      amount_ratio: Number(x?.amount_ratio ?? 0),
      cumulative_ratio: Number(x?.cumulative_ratio ?? 0),
      first_invoice_date: String(x?.first_invoice_date ?? ''),
      last_invoice_date: String(x?.last_invoice_date ?? ''),
      is_top10: Boolean(x?.is_top10),
      churn_kind: (x?.churn_kind === 'disappeared' ? 'disappeared' : 'new') as 'new' | 'disappeared',
      compare_year: x?.compare_year != null ? Number(x.compare_year) : undefined,
    }))
    return {
      ok: true,
      rows,
      total: Number(json.total ?? 0),
      prior_year: json.prior_year != null ? String(json.prior_year) : undefined,
      summary: json.summary
        ? {
            new_total: Number(json.summary.new_total ?? 0),
            new_top10: Number(json.summary.new_top10 ?? 0),
            disappeared_total: Number(json.summary.disappeared_total ?? 0),
            prior_year: String(json.summary.prior_year ?? ''),
          }
        : undefined,
      hint: json.hint != null ? String(json.hint) : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postDwsRebuild(params: {
  statYears?: string[]
  statYear?: string
}): Promise<{ ok: boolean; error?: { message?: string }; total_rows?: number }> {
  try {
    const res = await apiFetch('/api/dws/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(params.statYears?.length ? { stat_years: params.statYears } : {}),
        ...(params.statYear ? { stat_year: params.statYear } : {}),
      }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true, total_rows: Number(json.total_rows ?? 0) }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type AuditFlagRow = {
  flag_id: string
  rule_id: string
  risk_level: string
  flag_type: string
  group_id: string
  entity_id?: string | null
  entity_name?: string | null
  seller_name?: string | null
  seller_tax_no?: string | null
  amount?: number | null
  description: string
  suggestion: string
  is_confirmed?: boolean
  confirm_note?: string | null
  analysis_batch?: string
  created_at?: string | null
  detail_json?: string | null
  /** 仅规则落库使用；列表 API 不返回，请用 detail_json */
  invoice_list?: string | null
}

export async function fetchAuditMeta(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  stat_years?: string[]
  default_stat_year?: string
  flag_ready?: boolean
  total_flags?: number
  rules?: { rule_id: string; name: string; enabled: boolean }[]
  hint?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/audit/meta', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      stat_years: Array.isArray(json.stat_years) ? json.stat_years.map(String) : [],
      default_stat_year: json.default_stat_year != null ? String(json.default_stat_year) : undefined,
      flag_ready: Boolean(json.flag_ready),
      total_flags: Number(json.total_flags ?? 0),
      rules: Array.isArray(json.rules) ? json.rules : [],
      hint: json.hint != null ? String(json.hint) : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchAuditFlagsList(
  params: {
    statYear: string
    riskLevel?: string
    ruleId?: string
    keyword?: string
    batchId?: string
    trackStatus?: 'pending' | 'confirmed' | 'all'
    limit?: number
    offset?: number
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  total?: number
  rows?: AuditFlagRow[]
  summary?: { total: number; high: number; medium: number; low: number; confirmed?: number; pending?: number }
  error?: { message?: string }
}> {
  try {
    const q = new URLSearchParams()
    q.set('stat_year', params.statYear)
    if (params.riskLevel) q.set('risk_level', params.riskLevel)
    if (params.ruleId) q.set('rule_id', params.ruleId)
    if (params.keyword) q.set('keyword', params.keyword)
    if (params.batchId) q.set('batch_id', params.batchId)
    if (params.trackStatus && params.trackStatus !== 'all') q.set('track_status', params.trackStatus)
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const res = await apiFetch(`/api/audit/flags/list?${q.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const rows: AuditFlagRow[] = Array.isArray(json.rows)
      ? json.rows.map((r: any) => ({
          flag_id: String(r.flag_id ?? ''),
          rule_id: String(r.rule_id ?? ''),
          risk_level: String(r.risk_level ?? ''),
          flag_type: String(r.flag_type ?? ''),
          group_id: String(r.group_id ?? ''),
          entity_id: r.entity_id ?? null,
          entity_name: r.entity_name ?? null,
          seller_name: r.seller_name ?? null,
          seller_tax_no: r.seller_tax_no ?? null,
          amount: r.amount != null ? Number(r.amount) : null,
          description: String(r.description ?? ''),
          suggestion: String(r.suggestion ?? ''),
          is_confirmed: Boolean(r.is_confirmed),
          confirm_note: r.confirm_note != null ? String(r.confirm_note) : null,
          analysis_batch: r.analysis_batch != null ? String(r.analysis_batch) : undefined,
          created_at: r.created_at != null ? String(r.created_at) : null,
          detail_json: r.detail_json != null ? String(r.detail_json) : null,
        }))
      : []
    return {
      ok: true,
      total: Number(json.total ?? 0),
      rows,
      summary: json.summary ?? undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postAuditRun(params: {
  statYear?: string
  statYears?: string[]
  entityId?: string
  ruleIds?: string[]
  dryRun?: boolean
}): Promise<{ ok: boolean; error?: { message?: string }; total_flag_count?: number }> {
  try {
    const res = await apiFetch('/api/audit/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(params.statYear ? { stat_year: params.statYear } : {}),
        ...(params.statYears?.length ? { stat_years: params.statYears } : {}),
        ...(params.entityId ? { entity_id: params.entityId } : {}),
        ...(params.ruleIds?.length ? { rule_ids: params.ruleIds } : {}),
        ...(params.dryRun ? { dry_run: true } : {}),
      }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true, total_flag_count: Number(json.total_flag_count ?? 0) }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** 分页拉取全部疑点（用于 CSV 导出，单次 API limit 上限 2000） */
export async function fetchAllAuditFlagsList(
  params: {
    statYear: string
    riskLevel?: string
    ruleId?: string
    keyword?: string
    batchId?: string
    trackStatus?: 'pending' | 'confirmed' | 'all'
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  total: number
  rows: AuditFlagRow[]
  error?: { message?: string }
}> {
  const pageSize = 2000
  let offset = 0
  let total = 0
  const all: AuditFlagRow[] = []
  while (true) {
    const res = await fetchAuditFlagsList({ ...params, limit: pageSize, offset }, signal)
    if (!res.ok) {
      return { ok: false, total: 0, rows: [], error: res.error }
    }
    total = res.total ?? 0
    all.push(...(res.rows ?? []))
    if (all.length >= total || (res.rows?.length ?? 0) === 0) break
    offset += pageSize
  }
  return { ok: true, total, rows: all }
}

export async function postAuditFlagConfirm(params: {
  flagIds: string[]
  isConfirmed?: boolean
  confirmNote?: string
}): Promise<{ ok: boolean; message?: string; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/audit/flags/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flag_ids: params.flagIds,
        is_confirmed: params.isConfirmed !== false,
        confirm_note: params.confirmNote ?? '',
      }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true, message: json.message != null ? String(json.message) : undefined }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type AuditRuleExecutionMode = 'sql_scan' | 'post_scan' | 'sync'

export type AuditRuleListItem = {
  rule_id: string
  name: string
  enabled: boolean
  risk_level: string
  modules: string[]
  param_keys?: string[]
  execution_mode?: AuditRuleExecutionMode
  trigger_hint?: string
  rescan_included?: boolean
}

function mapAuditRuleListItem(r: Record<string, unknown>): AuditRuleListItem {
  const mode = r.execution_mode
  const executionMode: AuditRuleExecutionMode | undefined =
    mode === 'sql_scan' || mode === 'post_scan' || mode === 'sync' ? mode : undefined
  return {
    rule_id: String(r.rule_id ?? ''),
    name: String(r.name ?? ''),
    enabled: Boolean(r.enabled ?? true),
    risk_level: String(r.risk_level ?? ''),
    modules: Array.isArray(r.modules) ? r.modules.map(String) : [],
    param_keys: Array.isArray(r.param_keys) ? r.param_keys.map(String) : undefined,
    execution_mode: executionMode,
    trigger_hint: r.trigger_hint != null ? String(r.trigger_hint) : undefined,
    rescan_included: r.rescan_included != null ? Boolean(r.rescan_included) : undefined,
  }
}

export async function fetchAuditRulesConfig(signal?: AbortSignal): Promise<{
  ok: boolean
  yamlText?: string
  source?: string
  rulesList?: AuditRuleListItem[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/audit/rules/config', { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      yamlText: String(json.yaml_text ?? ''),
      source: json.source != null ? String(json.source) : undefined,
      rulesList: Array.isArray(json.rules_list)
        ? json.rules_list.map((r: any) => mapAuditRuleListItem(r))
        : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function validateAuditRulesConfig(yamlText: string): Promise<{
  ok: boolean
  message?: string
  errors?: string[]
  rulesList?: AuditRuleListItem[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/audit/rules/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml_text: yamlText }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) {
      return {
        ok: false,
        errors: Array.isArray(json.errors) ? json.errors.map(String) : undefined,
        error: json?.error ?? { message: json.errors?.[0] ?? `HTTP ${res.status}` },
      }
    }
    return {
      ok: true,
      message: json.message != null ? String(json.message) : undefined,
      rulesList: Array.isArray(json.rules_list)
        ? json.rules_list.map((r: any) => mapAuditRuleListItem(r))
        : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function saveAuditRulesConfig(yamlText: string): Promise<{
  ok: boolean
  message?: string
  source?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/audit/rules/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml_text: yamlText }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return {
      ok: true,
      message: json.message != null ? String(json.message) : undefined,
      source: json.source != null ? String(json.source) : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type CircularInvRow = {
  circ_id: string
  party_a_tax: string
  party_a_name?: string | null
  party_b_tax: string
  party_b_name?: string | null
  amount_a_to_b: number
  amount_b_to_a: number
  circular_ratio: number
  risk_level: string
}

export type ShellCoRow = {
  shell_id: string
  group_member_tax: string
  group_member_name?: string | null
  intermediary_tax: string
  intermediary_name?: string | null
  final_target_tax?: string | null
  final_target_name?: string | null
  amount_in: number
  amount_out: number
  passthrough_ratio: number
  risk_level: string
}

export async function fetchAuditRelatedCircular(
  params: {
    statYear: string
    riskLevel?: string
    keyword?: string
    limit?: number
    offset?: number
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; total?: number; rows?: CircularInvRow[]; error?: { message?: string } }> {
  try {
    const q = new URLSearchParams()
    q.set('stat_year', params.statYear)
    if (params.riskLevel) q.set('risk_level', params.riskLevel)
    if (params.keyword) q.set('keyword', params.keyword)
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const res = await apiFetch(`/api/audit/related/circular?${q.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const rows: CircularInvRow[] = Array.isArray(json.rows)
      ? json.rows.map((r: any) => ({
          circ_id: String(r.circ_id ?? ''),
          party_a_tax: String(r.party_a_tax ?? ''),
          party_a_name: r.party_a_name ?? null,
          party_b_tax: String(r.party_b_tax ?? ''),
          party_b_name: r.party_b_name ?? null,
          amount_a_to_b: Number(r.amount_a_to_b ?? 0),
          amount_b_to_a: Number(r.amount_b_to_a ?? 0),
          circular_ratio: Number(r.circular_ratio ?? 0),
          risk_level: String(r.risk_level ?? ''),
        }))
      : []
    return { ok: true, total: Number(json.total ?? 0), rows }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** 侧栏关联交易角标：对开发票 + 空壳传导合计（limit=1 仅取 total）。 */
export async function fetchAuditRelatedNavCount(
  statYear: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; total?: number }> {
  try {
    const [circ, shell] = await Promise.all([
      fetchAuditRelatedCircular({ statYear, limit: 1, offset: 0 }, signal),
      fetchAuditRelatedShell({ statYear, limit: 1, offset: 0 }, signal),
    ])
    if (signal?.aborted) return { ok: false }
    const total =
      (circ.ok ? Number(circ.total ?? 0) : 0) + (shell.ok ? Number(shell.total ?? 0) : 0)
    return { ok: circ.ok || shell.ok, total }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false }
    return { ok: false }
  }
}

export async function fetchAuditRelatedShell(
  params: { statYear: string; keyword?: string; limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<{ ok: boolean; total?: number; rows?: ShellCoRow[]; error?: { message?: string } }> {
  try {
    const q = new URLSearchParams()
    q.set('stat_year', params.statYear)
    if (params.keyword) q.set('keyword', params.keyword)
    if (params.limit != null) q.set('limit', String(params.limit))
    if (params.offset != null) q.set('offset', String(params.offset))
    const res = await apiFetch(`/api/audit/related/shell?${q.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    const rows: ShellCoRow[] = Array.isArray(json.rows)
      ? json.rows.map((r: any) => ({
          shell_id: String(r.shell_id ?? ''),
          group_member_tax: String(r.group_member_tax ?? ''),
          group_member_name: r.group_member_name ?? null,
          intermediary_tax: String(r.intermediary_tax ?? ''),
          intermediary_name: r.intermediary_name ?? null,
          final_target_tax: r.final_target_tax ?? null,
          final_target_name: r.final_target_name ?? null,
          amount_in: Number(r.amount_in ?? 0),
          amount_out: Number(r.amount_out ?? 0),
          passthrough_ratio: Number(r.passthrough_ratio ?? 0),
          risk_level: String(r.risk_level ?? ''),
        }))
      : []
    return { ok: true, total: Number(json.total ?? 0), rows }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type ScorecardRow = {
  scorecard_id: string
  entity_id: string
  entity_name: string
  stat_year: number
  total_amount: number
  total_count: number
  supplier_count: number
  flag_total: number
  flag_high: number
  flag_medium: number
  flag_low: number
  risk_score: number
  risk_level: string
  cr1: number | null
  cancel_ratio: number
  quality_score: number | null
}

export async function fetchCompareMeta(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  stat_years?: string[]
  default_stat_year?: string
  scorecard_ready?: boolean
  hint?: string | null
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/compare/meta', { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return {
      ok: true,
      stat_years: json.stat_years ?? [],
      default_stat_year: json.default_stat_year,
      scorecard_ready: json.scorecard_ready,
      hint: json.hint,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchCompareRankList(
  params: {
    statYear: string
    riskLevel?: string
    keyword?: string
    limit?: number
    offset?: number
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  total?: number
  summary?: { total: number; normal: number; watch: number; critical: number }
  rows?: ScorecardRow[]
  error?: { message?: string }
}> {
  const q = new URLSearchParams()
  q.set('stat_year', params.statYear)
  if (params.riskLevel) q.set('risk_level', params.riskLevel)
  if (params.keyword) q.set('keyword', params.keyword)
  q.set('limit', String(params.limit ?? 200))
  q.set('offset', String(params.offset ?? 0))
  try {
    const res = await apiFetch(`/api/compare/rank/list?${q.toString()}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const rows: ScorecardRow[] = Array.isArray(json.rows)
      ? json.rows.map((r: any) => ({
          scorecard_id: String(r.scorecard_id ?? ''),
          entity_id: String(r.entity_id ?? ''),
          entity_name: String(r.entity_name ?? ''),
          stat_year: Number(r.stat_year ?? 0),
          total_amount: Number(r.total_amount ?? 0),
          total_count: Number(r.total_count ?? 0),
          supplier_count: Number(r.supplier_count ?? 0),
          flag_total: Number(r.flag_total ?? 0),
          flag_high: Number(r.flag_high ?? 0),
          flag_medium: Number(r.flag_medium ?? 0),
          flag_low: Number(r.flag_low ?? 0),
          risk_score: Number(r.risk_score ?? 0),
          risk_level: String(r.risk_level ?? ''),
          cr1: r.cr1 == null ? null : Number(r.cr1),
          cancel_ratio: Number(r.cancel_ratio ?? 0),
          quality_score: r.quality_score == null ? null : Number(r.quality_score),
        }))
      : []
    return { ok: true, total: Number(json.total ?? 0), summary: json.summary, rows }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postCompareRebuild(body: {
  statYear?: string
  statYears?: string[]
}): Promise<{
  ok: boolean
  total_inserted?: number
  year_results?: { inserted?: number }[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/compare/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stat_year: body.statYear, stat_years: body.statYears }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true, total_inserted: json.total_inserted, year_results: json.year_results }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type CompareChartsMetric = 'amount' | 'flags' | 'score' | 'cr1' | 'cancel'

export type CompareChartPoint = {
  entity_id: string
  entity_name: string
  risk_level: string
  risk_score: number
  total_amount: number
  flag_high: number
  flag_total: number
  cr1: number | null
  cancel_ratio: number
  supplier_count: number
  value: number
}

export async function fetchCompareChartsSeries(
  params: { statYear: string; metric?: CompareChartsMetric; limit?: number },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  series?: CompareChartPoint[]
  risk_distribution?: { normal: number; watch: number; critical: number; total: number }
  error?: { message?: string }
}> {
  const q = new URLSearchParams()
  q.set('stat_year', params.statYear)
  q.set('metric', params.metric ?? 'amount')
  q.set('limit', String(params.limit ?? 15))
  try {
    const res = await apiFetch(`/api/compare/charts/series?${q.toString()}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const series: CompareChartPoint[] = Array.isArray(json.series)
      ? json.series.map((r: any) => ({
          entity_id: String(r.entity_id ?? ''),
          entity_name: String(r.entity_name ?? ''),
          risk_level: String(r.risk_level ?? ''),
          risk_score: Number(r.risk_score ?? 0),
          total_amount: Number(r.total_amount ?? 0),
          flag_high: Number(r.flag_high ?? 0),
          flag_total: Number(r.flag_total ?? 0),
          cr1: r.cr1 == null ? null : Number(r.cr1),
          cancel_ratio: Number(r.cancel_ratio ?? 0),
          supplier_count: Number(r.supplier_count ?? 0),
          value: Number(r.value ?? 0),
        }))
      : []
    return {
      ok: true,
      series,
      risk_distribution: json.risk_distribution ?? { normal: 0, watch: 0, critical: 0, total: 0 },
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DwsTaxBucketRow = {
  tax_bucket: string
  amount_je: number
  line_cnt: number
  amount_ratio: number
}

export async function fetchDwsOverviewTax(
  params: {
    statYear: string
    entityId?: string
    roleType?: string
    statMonth?: string
    dateFrom?: string
    dateTo?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  total_amount_je?: number
  rows?: DwsTaxBucketRow[]
  error?: { message?: string }
}> {
  const q = new URLSearchParams()
  q.set('stat_year', params.statYear)
  if (params.entityId) q.set('entity_id', params.entityId)
  q.set('role_type', params.roleType ?? '进项')
  if (params.statMonth?.trim()) q.set('stat_month', params.statMonth.trim())
  if (params.dateFrom?.trim()) q.set('date_from', params.dateFrom.trim())
  if (params.dateTo?.trim()) q.set('date_to', params.dateTo.trim())
  try {
    const res = await apiFetch(`/api/dws/overview/tax?${q.toString()}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const rows: DwsTaxBucketRow[] = Array.isArray(json.rows)
      ? json.rows.map((r: any) => ({
          tax_bucket: String(r.tax_bucket ?? ''),
          amount_je: Number(r.amount_je ?? 0),
          line_cnt: Number(r.line_cnt ?? 0),
          amount_ratio: Number(r.amount_ratio ?? 0),
        }))
      : []
    return { ok: true, total_amount_je: Number(json.total_amount_je ?? 0), rows }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DwsTaxMonthlyRow = {
  stat_month: number
  tax_bucket: string
  amount_je: number
  line_cnt: number
  amount_ratio: number
  month_total_amount_je?: number
}

export async function fetchDwsOverviewTaxMonthly(
  params: {
    statYear: string
    entityId?: string
    roleType?: string
    statMonth?: string
    dateFrom?: string
    dateTo?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  rows?: DwsTaxMonthlyRow[]
  error?: { message?: string }
}> {
  const q = new URLSearchParams()
  q.set('stat_year', params.statYear)
  if (params.entityId) q.set('entity_id', params.entityId)
  q.set('role_type', params.roleType ?? '进项')
  if (params.statMonth?.trim()) q.set('stat_month', params.statMonth.trim())
  if (params.dateFrom?.trim()) q.set('date_from', params.dateFrom.trim())
  if (params.dateTo?.trim()) q.set('date_to', params.dateTo.trim())
  try {
    const res = await apiFetch(`/api/dws/overview/tax-monthly?${q.toString()}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const rows: DwsTaxMonthlyRow[] = Array.isArray(json.rows)
      ? json.rows.map((r: any) => ({
          stat_month: Number(r.stat_month ?? 0),
          tax_bucket: String(r.tax_bucket ?? ''),
          amount_je: Number(r.amount_je ?? 0),
          line_cnt: Number(r.line_cnt ?? 0),
          amount_ratio: Number(r.amount_ratio ?? 0),
          month_total_amount_je:
            r.month_total_amount_je == null ? undefined : Number(r.month_total_amount_je),
        }))
      : []
    return { ok: true, rows }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DwsTradeRelationshipRow = {
  counterparty_id: string
  counterparty_name: string
  counterparty_role: string
  purchase_amount: number
  sales_amount: number
  purchase_cnt: number
  sales_cnt: number
  purchase_latest_date: string
  sales_latest_date: string
  total_amount_abs: number
}

export async function fetchDwsTradeRelationships(
  params: {
    statYear: string
    entityId: string
    roleFilter?: 'all' | '供应商' | '客户' | '往来单位'
    keyword?: string
    counterpartyId?: string
    partyATax?: string
    partyBTax?: string
    limit?: number
    offset?: number
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  rows?: DwsTradeRelationshipRow[]
  total?: number
  role_summary?: Record<string, number>
  hint?: string
  caliber_hint?: string
  error?: { message?: string }
}> {
  const q = new URLSearchParams()
  q.set('stat_year', params.statYear)
  q.set('entity_id', params.entityId)
  if (params.roleFilter && params.roleFilter !== 'all') q.set('role_filter', params.roleFilter)
  if (params.keyword) q.set('keyword', params.keyword)
  if (params.counterpartyId?.trim()) q.set('counterparty_id', params.counterpartyId.trim())
  if (params.partyATax?.trim()) q.set('party_a_tax', params.partyATax.trim())
  if (params.partyBTax?.trim()) q.set('party_b_tax', params.partyBTax.trim())
  if (params.limit != null) q.set('limit', String(params.limit))
  if (params.offset != null) q.set('offset', String(params.offset))
  try {
    const res = await apiFetch(`/api/dws/trade/relationships?${q.toString()}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const rows: DwsTradeRelationshipRow[] = Array.isArray(json.rows)
      ? json.rows.map((r: any) => ({
          counterparty_id: String(r.counterparty_id ?? ''),
          counterparty_name: String(r.counterparty_name ?? ''),
          counterparty_role: String(r.counterparty_role ?? ''),
          purchase_amount: Number(r.purchase_amount ?? 0),
          sales_amount: Number(r.sales_amount ?? 0),
          purchase_cnt: Number(r.purchase_cnt ?? 0),
          sales_cnt: Number(r.sales_cnt ?? 0),
          purchase_latest_date: String(r.purchase_latest_date ?? ''),
          sales_latest_date: String(r.sales_latest_date ?? ''),
          total_amount_abs: Number(r.total_amount_abs ?? 0),
        }))
      : []
    return {
      ok: true,
      rows,
      total: Number(json.total ?? 0),
      role_summary: json.role_summary ?? {},
      hint: json.hint != null ? String(json.hint) : undefined,
      caliber_hint: json.caliber_hint != null ? String(json.caliber_hint) : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DwsTaxInOutDeviationRow = {
  tax_bucket: string
  input_amount_je: number
  input_amount_ratio: number
  input_line_cnt: number
  output_amount_je: number
  output_amount_ratio: number
  output_line_cnt: number
  ratio_diff: number
  exceeded_threshold?: boolean
}

export async function fetchDwsTaxInOutDeviation(
  params: { statYear: string; entityId: string },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  input_total_amount_je?: number
  output_total_amount_je?: number
  amount_ratio_input_over_output?: number | null
  mix_deviation_l1?: number
  deviation_threshold_pct?: number
  exceeded_bucket_count?: number
  tax_dev_flags?: TaxDevFlagSummary
  rows?: DwsTaxInOutDeviationRow[]
  caliber_hint?: string
  error?: { message?: string }
}> {
  const q = new URLSearchParams()
  q.set('stat_year', params.statYear)
  q.set('entity_id', params.entityId)
  try {
    const res = await apiFetch(`/api/dws/tax/in-out-deviation?${q.toString()}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const rows: DwsTaxInOutDeviationRow[] = Array.isArray(json.rows)
      ? json.rows.map((r: any) => ({
          tax_bucket: String(r.tax_bucket ?? ''),
          input_amount_je: Number(r.input_amount_je ?? 0),
          input_amount_ratio: Number(r.input_amount_ratio ?? 0),
          input_line_cnt: Number(r.input_line_cnt ?? 0),
          output_amount_je: Number(r.output_amount_je ?? 0),
          output_amount_ratio: Number(r.output_amount_ratio ?? 0),
          output_line_cnt: Number(r.output_line_cnt ?? 0),
          ratio_diff: Number(r.ratio_diff ?? 0),
          exceeded_threshold: Boolean(r.exceeded_threshold),
        }))
      : []
    return {
      ok: true,
      input_total_amount_je: Number(json.input_total_amount_je ?? 0),
      output_total_amount_je: Number(json.output_total_amount_je ?? 0),
      amount_ratio_input_over_output:
        json.amount_ratio_input_over_output != null ? Number(json.amount_ratio_input_over_output) : null,
      mix_deviation_l1: Number(json.mix_deviation_l1 ?? 0),
      deviation_threshold_pct: json.deviation_threshold_pct != null ? Number(json.deviation_threshold_pct) : undefined,
      exceeded_bucket_count: json.exceeded_bucket_count != null ? Number(json.exceeded_bucket_count) : undefined,
      tax_dev_flags: json.tax_dev_flags
        ? {
            total: Number(json.tax_dev_flags.total ?? 0),
            confirmed: Number(json.tax_dev_flags.confirmed ?? 0),
            pending: Number(json.tax_dev_flags.pending ?? 0),
            amount: Number(json.tax_dev_flags.amount ?? 0),
          }
        : undefined,
      rows,
      caliber_hint: json.caliber_hint != null ? String(json.caliber_hint) : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type ReportChapter = { id: string; label: string; default?: boolean }

export type ReportArchiveFile = {
  file_name: string
  stat_year?: string | null
  size_bytes: number
  modified_at: number
  download_url?: string
}

export function getReportDownloadUrl(fileName: string): string {
  return apiUrl(`/api/report/download?file=${encodeURIComponent(fileName)}`)
}

export async function fetchReportMeta(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  stat_years?: string[]
  default_stat_year?: string
  default_title?: string
  chapters?: ReportChapter[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/report/meta', { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return {
      ok: true,
      stat_years: json.stat_years ?? [],
      default_stat_year: json.default_stat_year,
      default_title: json.default_title,
      chapters: json.chapters ?? [],
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchAuditPendingCount(
  params?: { statYear?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; pending?: number; error?: { message?: string } }> {
  try {
    const q = new URLSearchParams()
    if (params?.statYear) q.set('stat_year', params.statYear)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    const res = await apiFetch(`/api/audit/pending-count${suffix}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true, pending: Number(json.pending ?? 0) }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DwsTaxRiskBreakdownRow = {
  tax_bucket: string
  deviation_amount: number
  ratio_diff_pp?: number | null
  source?: string
  rule_id?: string | null
  flag_count?: number
}

export type TaxDevFlagSummary = {
  total: number
  confirmed: number
  pending: number
  amount: number
}

export async function fetchDwsTaxRiskExposure(
  params: { statYear: string; entityId: string },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  total_exposure?: number
  high_risk_ratio?: number
  deviation_exposure?: number
  rule_05_amount?: number
  rule_08_amount?: number
  rule_tax_dev_amount?: number
  deviation_threshold_pct?: number
  breakdown?: DwsTaxRiskBreakdownRow[]
  error?: { message?: string }
}> {
  const q = new URLSearchParams()
  q.set('stat_year', params.statYear)
  q.set('entity_id', params.entityId)
  try {
    const res = await apiFetch(`/api/dws/tax/risk-exposure?${q.toString()}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return {
      ok: true,
      total_exposure: Number(json.total_exposure ?? 0),
      high_risk_ratio: Number(json.high_risk_ratio ?? 0),
      deviation_exposure: json.deviation_exposure != null ? Number(json.deviation_exposure) : undefined,
      rule_05_amount: json.rule_05_amount != null ? Number(json.rule_05_amount) : undefined,
      rule_08_amount: json.rule_08_amount != null ? Number(json.rule_08_amount) : undefined,
      rule_tax_dev_amount: json.rule_tax_dev_amount != null ? Number(json.rule_tax_dev_amount) : undefined,
      deviation_threshold_pct:
        json.deviation_threshold_pct != null ? Number(json.deviation_threshold_pct) : undefined,
      breakdown: Array.isArray(json.breakdown)
        ? json.breakdown.map((r: any) => ({
            tax_bucket: String(r.tax_bucket ?? ''),
            deviation_amount: Number(r.deviation_amount ?? 0),
            ratio_diff_pp: r.ratio_diff_pp != null ? Number(r.ratio_diff_pp) : null,
            source: r.source != null ? String(r.source) : undefined,
            rule_id: r.rule_id != null ? String(r.rule_id) : null,
            flag_count: r.flag_count != null ? Number(r.flag_count) : undefined,
          }))
        : [],
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DwsTradeGraphNode = {
  id: string
  label: string
  role: string
  is_center?: boolean
  is_shell?: boolean
  is_circular?: boolean
  has_confirmed_flag?: boolean
}

export type DwsTradeGraphEdge = {
  source: string
  target: string
  role: string
  amount: number
  invoice_cnt: number
}

export async function fetchDwsTradeGraph(
  params: {
    statYear: string
    entityId: string
    minAmount?: number
    counterpartyId?: string
    partyATax?: string
    partyBTax?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  nodes?: DwsTradeGraphNode[]
  edges?: DwsTradeGraphEdge[]
  truncated?: boolean
  truncatedMessage?: string | null
  nodeCount?: number
  edgeCount?: number
  error?: { message?: string }
}> {
  const q = new URLSearchParams()
  q.set('stat_year', params.statYear)
  q.set('entity_id', params.entityId)
  if (params.minAmount != null) q.set('min_amount', String(params.minAmount))
  if (params.counterpartyId?.trim()) q.set('counterparty_id', params.counterpartyId.trim())
  if (params.partyATax?.trim()) q.set('party_a_tax', params.partyATax.trim())
  if (params.partyBTax?.trim()) q.set('party_b_tax', params.partyBTax.trim())
  try {
    const res = await apiFetch(`/api/dws/trade/graph?${q.toString()}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return {
      ok: true,
      nodes: Array.isArray(json.nodes) ? json.nodes : [],
      edges: Array.isArray(json.edges) ? json.edges : [],
      truncated: Boolean(json.truncated),
      truncatedMessage: json.truncated_message ?? null,
      nodeCount: json.node_count != null ? Number(json.node_count) : undefined,
      edgeCount: json.edge_count != null ? Number(json.edge_count) : undefined,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchLicenseInfo(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  license?: LicenseInfo
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/settings/license', { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return {
      ok: true,
      license: {
        tier: json.tier,
        customer: json.customer,
        expiresAt: json.expires_at,
        exportReport: Boolean(json.export_report),
        maxEntities: json.max_entities != null ? Number(json.max_entities) : undefined,
        maxInvoices: json.max_invoices != null ? Number(json.max_invoices) : undefined,
        maxYears: json.max_years != null ? Number(json.max_years) : undefined,
        crossGroup: Boolean(json.cross_group),
        isExpired: Boolean(json.is_expired),
        isOverridden: Boolean(json.is_overridden),
        source: json.source,
        licPath: json.lic_path,
        licError: json.lic_error ?? null,
        trialHint: json.trial_hint ?? null,
        gates: json.gates,
      },
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type LicenseInfo = {
  tier?: string
  customer?: string
  expiresAt?: string
  exportReport?: boolean
  maxEntities?: number
  maxInvoices?: number
  maxYears?: number
  crossGroup?: boolean
  isExpired?: boolean
  isOverridden?: boolean
  source?: string
  licPath?: string
  licError?: string | null
  trialHint?: string | null
  gates?: { export_report?: boolean; cross_group?: boolean }
}

export async function postLicenseImport(
  license: Record<string, unknown>,
  actor?: string,
): Promise<{ ok: boolean; errors?: string[]; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/settings/license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license, actor }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) {
      return { ok: false, errors: json?.errors, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postLicenseReset(): Promise<{ ok: boolean; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/settings/license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type AppUserRow = {
  username: string
  displayName: string
  role: string
  roleLabel?: string
  enabled: boolean
}

export type AppRoleRow = {
  role: string
  label?: string
  description?: string
  permissions?: string[]
}

export type AuditLogEntry = {
  ts?: string
  username?: string
  action?: string
  detail?: Record<string, unknown>
}

export async function postAuthLogin(body: {
  username: string
  password: string
  remember?: boolean
}): Promise<{ ok: boolean; user?: AppUserRow; error?: { message?: string; code?: string } }> {
  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: body.username, password: body.password }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok || !json.user) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const token = String(json.token || '').trim()
    if (token) setSessionToken(token, body.remember)
    const u = json.user
    return {
      ok: true,
      user: {
        username: String(u.username ?? ''),
        displayName: String(u.display_name ?? u.displayName ?? ''),
        role: String(u.role ?? ''),
        roleLabel: u.role_label ?? u.roleLabel,
        enabled: Boolean(u.enabled ?? true),
      },
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchAuthMe(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  user?: AppUserRow
  error?: { message?: string; code?: string }
}> {
  try {
    const res = await apiFetch('/api/auth/me', { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok || !json.user) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const u = json.user
    return {
      ok: true,
      user: {
        username: String(u.username ?? ''),
        displayName: String(u.display_name ?? u.displayName ?? ''),
        role: String(u.role ?? ''),
        roleLabel: u.role_label ?? u.roleLabel,
        enabled: Boolean(u.enabled ?? true),
      },
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postAuthLogout(): Promise<{ ok: boolean; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/auth/logout', { method: 'POST' })
    const json = (await res.json().catch(() => ({}))) as any
    setSessionToken(null)
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true }
  } catch (e) {
    setSessionToken(null)
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchUsers(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  users?: AppUserRow[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/users', { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const users: AppUserRow[] = Array.isArray(json.users)
      ? json.users.map((u: any) => ({
          username: String(u.username ?? ''),
          displayName: String(u.display_name ?? u.displayName ?? ''),
          role: String(u.role ?? ''),
          roleLabel: u.role_label ?? u.roleLabel,
          enabled: Boolean(u.enabled ?? true),
        }))
      : []
    return { ok: true, users }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchUserRoles(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  roles?: AppRoleRow[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/users/roles', { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true, roles: json.roles ?? [] }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postUserCreate(body: {
  username: string
  displayName: string
  role: string
  password: string
  actor?: string
}): Promise<{ ok: boolean; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: body.username,
        display_name: body.displayName,
        role: body.role,
        password: body.password,
        actor: body.actor,
      }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postUserUpdate(body: {
  username: string
  displayName?: string
  role?: string
  password?: string
  enabled?: boolean
  actor?: string
}): Promise<{ ok: boolean; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/users/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function deleteUser(
  username: string,
  actor?: string,
): Promise<{ ok: boolean; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/users/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, actor }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchAuditLog(
  params?: { limit?: number; action?: string; username?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; aborted?: boolean; entries?: AuditLogEntry[]; error?: { message?: string } }> {
  try {
    const q = new URLSearchParams()
    if (params?.limit != null) q.set('limit', String(params.limit))
    if (params?.action) q.set('action', params.action)
    if (params?.username) q.set('username', params.username)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    const res = await apiFetch(`/api/audit-log${suffix}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true, entries: json.entries ?? [] }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchReportArchive(
  params?: { statYear?: string; template?: string },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  files?: ReportArchiveFile[]
  total?: number
  error?: { message?: string }
}> {
  try {
    const q = new URLSearchParams()
    if (params?.statYear) q.set('stat_year', params.statYear)
    if (params?.template) q.set('template', params.template)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    const res = await apiFetch(`/api/report/archive${suffix}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const files: ReportArchiveFile[] = Array.isArray(json.files)
      ? json.files.map((f: any) => ({
          file_name: String(f.file_name ?? ''),
          stat_year: f.stat_year != null ? String(f.stat_year) : null,
          size_bytes: Number(f.size_bytes ?? 0),
          modified_at: Number(f.modified_at ?? 0),
          download_url: f.download_url ? String(f.download_url) : undefined,
        }))
      : []
    return { ok: true, files, total: Number(json.total ?? files.length) }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postReportArchiveBatchDownload(fileNames: string[]): Promise<{
  ok: boolean
  blob?: Blob
  fileName?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/report/archive/batch-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_names: fileNames }),
    })
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as any
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') ?? ''
    const m = /filename="?([^";]+)"?/.exec(cd)
    return { ok: true, blob, fileName: m?.[1] ?? 'reports.zip' }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export function getExportInvoicesUrl(params: {
  statYear?: string
  entityId?: string
  dateFrom?: string
  dateTo?: string
  fpzt?: string
  sellerTaxNo?: string
  format?: string
}): string {
  const q = new URLSearchParams()
  if (params.statYear) q.set('stat_year', params.statYear)
  if (params.entityId) q.set('entity_id', params.entityId)
  if (params.dateFrom) q.set('date_from', params.dateFrom)
  if (params.dateTo) q.set('date_to', params.dateTo)
  if (params.fpzt) q.set('fpzt', params.fpzt)
  if (params.sellerTaxNo) q.set('seller_tax_no', params.sellerTaxNo)
  q.set('format', params.format ?? 'csv')
  return apiUrl(`/api/export/invoices?${q.toString()}`)
}

export async function fetchExportInvoicesMeta(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  stat_years?: string[]
  default_stat_year?: string
  invoice_status_options?: string[]
  total_headers?: number
  max_export_rows?: number
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/export/invoices/meta', { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return {
      ok: true,
      stat_years: json.stat_years ?? [],
      default_stat_year: json.default_stat_year,
      invoice_status_options: json.invoice_status_options ?? [],
      total_headers: Number(json.total_headers ?? 0),
      max_export_rows: Number(json.max_export_rows ?? 50000),
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchExportInvoicesCount(
  params: {
    statYear?: string
    entityId?: string
    dateFrom?: string
    dateTo?: string
    fpzt?: string
    sellerTaxNo?: string
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  aborted?: boolean
  rowCount?: number
  maxExportRows?: number
  capped?: boolean
  message?: string | null
  error?: { message?: string }
}> {
  const q = new URLSearchParams()
  if (params.statYear) q.set('stat_year', params.statYear)
  if (params.entityId) q.set('entity_id', params.entityId)
  if (params.dateFrom) q.set('date_from', params.dateFrom)
  if (params.dateTo) q.set('date_to', params.dateTo)
  if (params.fpzt) q.set('fpzt', params.fpzt)
  if (params.sellerTaxNo) q.set('seller_tax_no', params.sellerTaxNo)
  try {
    const res = await apiFetch(`/api/export/invoices/count?${q.toString()}`, { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return {
      ok: true,
      rowCount: Number(json.row_count ?? 0),
      maxExportRows: Number(json.max_export_rows ?? 50000),
      capped: Boolean(json.capped),
      message: json.message ?? null,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postExportInvoices(body: {
  statYear?: string
  entityId?: string
  dateFrom?: string
  dateTo?: string
  fpzt?: string
  sellerTaxNo?: string
  format?: 'csv' | 'xlsx'
}): Promise<{ ok: boolean; blob?: Blob; fileName?: string; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/export/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stat_year: body.statYear,
        entity_id: body.entityId,
        date_from: body.dateFrom,
        date_to: body.dateTo,
        fpzt: body.fpzt,
        seller_tax_no: body.sellerTaxNo,
        format: body.format ?? 'csv',
      }),
    })
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as any
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') ?? ''
    const m = /filename="?([^";]+)"?/.exec(cd)
    return { ok: true, blob, fileName: m?.[1] }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postReportGenerate(body: {
  statYear: string
  title?: string
  chapters?: Record<string, boolean>
}): Promise<{
  ok: boolean
  file_name?: string
  download_url?: string
  size_bytes?: number
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/report/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stat_year: body.statYear,
        title: body.title,
        chapters: body.chapters,
      }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return {
      ok: true,
      file_name: json.file_name,
      download_url: json.download_url,
      size_bytes: json.size_bytes,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postReportDeliveryPackage(body: {
  statYear: string
  title?: string
  chapters?: Record<string, boolean>
  entityId?: string
  flagFilters?: { riskLevel?: string; ruleId?: string; trackStatus?: string }
  includeInvoices?: boolean
  includeFinance?: boolean
  actor?: string
  async?: boolean
}): Promise<{
  ok: boolean
  async?: boolean
  runId?: string
  blob?: Blob
  fileName?: string
  message?: string
  error?: { message?: string; code?: string }
}> {
  try {
    const res = await apiFetch('/api/report/delivery-package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stat_year: body.statYear,
        title: body.title,
        chapters: body.chapters,
        entity_id: body.entityId,
        flag_filters: body.flagFilters
          ? {
              risk_level: body.flagFilters.riskLevel,
              rule_id: body.flagFilters.ruleId,
              track_status: body.flagFilters.trackStatus,
            }
          : undefined,
        include_invoices: body.includeInvoices,
        include_finance: body.includeFinance,
        actor: body.actor,
        async: body.async === true,
      }),
    })
    if (body.async === true) {
      const json = (await res.json().catch(() => ({}))) as any
      if (!json?.ok) {
        return {
          ok: false,
          error: json?.error ?? { message: `HTTP ${res.status}`, code: json?.error?.code },
        }
      }
      return {
        ok: true,
        async: true,
        runId: json.run_id != null ? String(json.run_id) : undefined,
        message: json.message != null ? String(json.message) : undefined,
      }
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as any
      return {
        ok: false,
        error: json?.error ?? { message: `HTTP ${res.status}`, code: json?.error?.code },
      }
    }
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') ?? ''
    const m = /filename="?([^";]+)"?/.exec(cd)
    return { ok: true, blob, fileName: m?.[1] ?? 'delivery_package.zip' }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DeliveryPackageRecord = {
  package_id?: string
  run_id?: string
  status?: string
  file_name?: string
  size_bytes?: number
  stat_year?: number | string
  title?: string
  started_at?: string | null
  finished_at?: string | null
  message?: string
  error?: { message?: string; code?: string }
  error_code?: string | null
  download_url?: string
  params?: Record<string, unknown>
}

export async function fetchDeliveryPackages(
  params: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ ok: boolean; packages?: DeliveryPackageRecord[]; total?: number; error?: { message?: string } }> {
  try {
    const qs = new URLSearchParams()
    if (params.limit != null) qs.set('limit', String(params.limit))
    const res = await apiFetch(`/api/report/delivery-packages?${qs.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true, packages: json.packages ?? [], total: json.total }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDeliveryPackageStatus(
  runId: string,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  status?: string
  file_name?: string
  size_bytes?: number
  message?: string
  error?: { message?: string; code?: string }
  error_code?: string
}> {
  try {
    const qs = new URLSearchParams({ run_id: runId })
    const res = await apiFetch(`/api/report/delivery-package/status?${qs.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return {
      ok: true,
      status: json.status != null ? String(json.status) : undefined,
      file_name: json.file_name != null ? String(json.file_name) : undefined,
      size_bytes: json.size_bytes != null ? Number(json.size_bytes) : undefined,
      message: json.message != null ? String(json.message) : undefined,
      error: json.error,
      error_code: json.error_code != null ? String(json.error_code) : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type DeliveryPackageEstimateSection = {
  id: string
  label: string
  path: string
  kind?: string
  included?: boolean
  row_count?: number | null
  size_bytes?: number | null
  chapter_id?: string
}

export type DeliveryPackageEstimate = {
  audit_flags?: number
  report_docx?: number
  finance_reconcile?: number | null
  invoice_detail?: number | null
  invoice_detail_total?: number | null
  data_quality_metrics?: number | null
  data_quality_scanned?: number | null
  tax_code_analysis?: number | null
  tax_risk_exposure?: number | null
  total_uncompressed_bytes?: number
  total_zip_bytes_est?: number
}

export async function fetchDeliveryPackageEstimate(
  params: {
    statYear: string
    entityId?: string
    chapters?: Record<string, boolean>
    includeInvoices?: boolean
    includeFinance?: boolean
    includeDataQuality?: boolean
  },
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  estimates?: DeliveryPackageEstimate
  sections?: DeliveryPackageEstimateSection[]
  notes?: string[]
  max_zip_mb?: number
  error?: { message?: string }
}> {
  try {
    const qs = new URLSearchParams({ stat_year: params.statYear })
    if (params.entityId) qs.set('entity_id', params.entityId)
    if (params.chapters) qs.set('chapters', JSON.stringify(params.chapters))
    if (params.includeInvoices === false) qs.set('include_invoices', '0')
    if (params.includeFinance === false) qs.set('include_finance', '0')
    if (params.includeDataQuality === false) qs.set('include_data_quality', '0')
    const res = await apiFetch(`/api/report/delivery-package/estimate?${qs.toString()}`, { signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return {
      ok: true,
      estimates: json.estimates ?? {},
      sections: Array.isArray(json.sections) ? json.sections : [],
      notes: Array.isArray(json.notes) ? json.notes.map(String) : [],
      max_zip_mb: json.max_zip_mb != null ? Number(json.max_zip_mb) : undefined,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchDeliveryPackageDownload(packageId: string): Promise<{
  ok: boolean
  blob?: Blob
  fileName?: string
  error?: { message?: string }
}> {
  try {
    const qs = new URLSearchParams({ package_id: packageId })
    const res = await apiFetch(`/api/report/delivery-package/download?${qs.toString()}`)
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as any
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') ?? ''
    const m = /filename="?([^";]+)"?/.exec(cd)
    return { ok: true, blob, fileName: m?.[1] ?? 'delivery_package.zip' }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type ReportTemplate = {
  template_id: string
  name: string
  title_template: string
  description?: string
  chapters: Record<string, boolean>
  is_builtin: boolean
  updated_at?: string
}

export async function fetchReportTemplates(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  templates?: ReportTemplate[]
  chapter_defs?: ReportChapter[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/report/templates/list', { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const templates: ReportTemplate[] = Array.isArray(json.templates)
      ? json.templates.map((t: any) => ({
          template_id: String(t.template_id ?? ''),
          name: String(t.name ?? ''),
          title_template: String(t.title_template ?? ''),
          description: t.description ? String(t.description) : undefined,
          chapters: (t.chapters && typeof t.chapters === 'object' ? t.chapters : {}) as Record<
            string,
            boolean
          >,
          is_builtin: Boolean(t.is_builtin),
          updated_at: t.updated_at ? String(t.updated_at) : undefined,
        }))
      : []
    const chapter_defs: ReportChapter[] = Array.isArray(json.chapter_defs)
      ? json.chapter_defs.map((c: any) => ({
          id: String(c.id ?? ''),
          label: String(c.label ?? ''),
          default: c.default !== false,
        }))
      : []
    return { ok: true, templates, chapter_defs }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postReportTemplateSave(body: {
  template_id?: string
  name: string
  title_template?: string
  description?: string
  chapters?: Record<string, boolean>
}): Promise<{ ok: boolean; created?: boolean; error?: { message?: string } }> {
  try {
    const res = await apiFetch('/api/report/templates/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true, created: Boolean(json.created) }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postReportTemplateDelete(templateId: string): Promise<{
  ok: boolean
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/report/templates/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: templateId }),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type SettingsThresholdItem = {
  key: string
  label: string
  description?: string
  type?: string
  min?: number
  max?: number
  default?: number
  base_value?: number
  override_value?: number | null
  effective_value?: number
  is_overridden?: boolean
}

export async function fetchSettingsThresholds(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  items?: SettingsThresholdItem[]
  hint?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/settings/thresholds', { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    return { ok: true, items: json.items ?? [], hint: json.hint }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postSettingsThresholds(body: {
  items?: Record<string, number>
  reset_keys?: string[]
}): Promise<{
  ok: boolean
  errors?: string[]
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/settings/thresholds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) {
      return {
        ok: false,
        errors: json.errors,
        error: json?.error ?? { message: json.errors?.join('；') ?? '请求失败' },
      }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type InstanceConfig = {
  display_name: string
  instance_id: string
  default_stat_year: number | null
  scope_root_id: string
  notes: string
}

export type InstanceConfigItem = {
  key: string
  label: string
  type?: string
  default?: unknown
  effective_value?: unknown
  is_overridden?: boolean
}

export type InstanceSystemInfo = {
  project_root?: string
  config_dir?: string
  db_path?: string
  field_mapping_path?: string
  app_version?: string
  build_time?: string | null
}

export async function fetchSettingsInstance(signal?: AbortSignal): Promise<{
  ok: boolean
  aborted?: boolean
  config?: InstanceConfig
  items?: InstanceConfigItem[]
  system?: InstanceSystemInfo
  hint?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/settings/instance', { signal })
    if (signal?.aborted) return { ok: false, aborted: true }
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) return { ok: false, error: json?.error ?? { message: '请求失败' } }
    const cfg = json.config ?? {}
    return {
      ok: true,
      config: {
        display_name: String(cfg.display_name ?? ''),
        instance_id: String(cfg.instance_id ?? ''),
        default_stat_year:
          cfg.default_stat_year == null || cfg.default_stat_year === ''
            ? null
            : Number(cfg.default_stat_year),
        scope_root_id: String(cfg.scope_root_id ?? ''),
        notes: String(cfg.notes ?? ''),
      },
      items: json.items ?? [],
      system: json.system ?? {},
      hint: json.hint,
    }
  } catch (e) {
    if (isFetchAbortError(e)) return { ok: false, aborted: true }
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postSettingsInstance(body: {
  config: Partial<InstanceConfig>
  reset_keys?: string[]
}): Promise<{
  ok: boolean
  errors?: string[]
  config?: InstanceConfig
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/settings/instance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) {
      return {
        ok: false,
        errors: json.errors,
        error: json?.error ?? { message: json.errors?.join('；') ?? '请求失败' },
      }
    }
    const cfg = json.config ?? {}
    return {
      ok: true,
      config: {
        display_name: String(cfg.display_name ?? ''),
        instance_id: String(cfg.instance_id ?? ''),
        default_stat_year:
          cfg.default_stat_year == null || cfg.default_stat_year === ''
            ? null
            : Number(cfg.default_stat_year),
        scope_root_id: String(cfg.scope_root_id ?? ''),
        notes: String(cfg.notes ?? ''),
      },
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postDemoSeedAnalysisData(body?: {
  skipAuditFlags?: boolean
}): Promise<{
  ok: boolean
  stat_year?: number
  verification?: Record<string, unknown>
  warning?: string
  error?: { message?: string }
}> {
  try {
    const res = await apiFetch('/api/demo/seed-analysis-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) {
      return {
        ok: false,
        warning: json.warning,
        error: json?.error ?? { message: json.warning ?? '请求失败' },
      }
    }
    return {
      ok: true,
      stat_year: json.stat_year,
      verification: json.verification,
      warning: json.warning,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export type FinanceLedgerBatch = {
  batch_id: string
  batch_name: string
  source_file: string
  stat_year: number | null
  row_count: number
  reject_count: number
  import_status: string
  imported_at: string
}

export type FinanceReconcileOverview = {
  ok: boolean
  batch_id?: string | null
  stat_year?: number | null
  entity_id?: string | null
  dwd_ready?: boolean
  ledger_ready?: boolean
  hint?: string | null
  kpi?: {
    total_rows: number
    matched_count: number
    unmatched_count: number
    total_diff_amount: number
    type_a_count: number
    type_b_count: number
    type_c_count: number
    type_d_count: number
  }
  error?: { message?: string; detail?: string }
}

export type FinanceReconcileDetailRow = {
  diff_id: string
  batch_id: string
  tax_id: string
  entity_name: string
  stat_year: number
  stat_month: number | null
  role_type: string
  subject_code: string
  subject_name: string
  ledger_amount: number | null
  invoice_net: number | null
  diff_amount: number
  diff_type: string
  status: string
}

export type FinanceDiffSummary = {
  ok: boolean
  batch_id?: string | null
  kpi?: {
    diff_count: number
    diff_amount_total: number
    explained_count: number
    pending_count: number
  }
  by_type?: Record<string, { count: number; diff_amount: number }>
  error?: { message?: string; detail?: string }
}

export async function fetchFinanceLedgerBatches(params?: {
  limit?: number
  signal?: AbortSignal
}): Promise<{ ok: boolean; batches: FinanceLedgerBatch[]; error?: { message?: string } }> {
  const lim = Math.max(1, Math.min(200, Math.floor(params?.limit ?? 50)))
  try {
    const res = await apiFetch(`/api/finance/ledger/batches?limit=${lim}`, { signal: params?.signal })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, batches: [], error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const raw = Array.isArray(json.batches) ? json.batches : []
    return {
      ok: true,
      batches: raw.map((r: any) => ({
        batch_id: String(r?.batch_id ?? ''),
        batch_name: String(r?.batch_name ?? r?.batch_id ?? ''),
        source_file: String(r?.source_file ?? ''),
        stat_year: r?.stat_year == null ? null : Number(r.stat_year),
        row_count: Number(r?.row_count ?? 0),
        reject_count: Number(r?.reject_count ?? 0),
        import_status: String(r?.import_status ?? ''),
        imported_at: String(r?.imported_at ?? ''),
      })),
    }
  } catch (e) {
    return { ok: false, batches: [], error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function postFinanceLedgerImport(params: {
  file: File
  batchName?: string
  statYear?: number
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  batch_id?: string
  import_status?: string
  row_count?: number
  reject_count?: number
  message?: string
  error?: { message?: string }
}> {
  const fd = new FormData()
  fd.append('file', params.file)
  if (params.batchName) fd.append('batch_name', params.batchName)
  if (params.statYear != null) fd.append('stat_year', String(params.statYear))
  try {
    const res = await apiFetch('/api/finance/ledger/import', {
      method: 'POST',
      body: fd,
      signal: params.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!json?.ok) {
      return {
        ok: false,
        message: json?.message,
        error: json?.error ?? { message: json?.message ?? `HTTP ${res.status}` },
      }
    }
    return {
      ok: true,
      batch_id: json.batch_id,
      import_status: json.import_status,
      row_count: json.row_count,
      reject_count: json.reject_count,
      message: json.message,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchFinanceReconcileOverview(params?: {
  batchId?: string
  statYear?: number
  entityId?: string
  signal?: AbortSignal
}): Promise<FinanceReconcileOverview> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.statYear != null) q.set('stat_year', String(params.statYear))
  if (params?.entityId) q.set('entity_id', params.entityId)
  try {
    const res = await apiFetch(`/api/finance/reconcile/overview?${q.toString()}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      batch_id: json.batch_id,
      stat_year: json.stat_year,
      entity_id: json.entity_id,
      dwd_ready: Boolean(json.dwd_ready),
      ledger_ready: Boolean(json.ledger_ready),
      hint: json.hint,
      kpi: json.kpi,
    }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchFinanceDiffSummary(params?: {
  batchId?: string
  statYear?: number
  entityId?: string
  signal?: AbortSignal
}): Promise<FinanceDiffSummary> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.statYear != null) q.set('stat_year', String(params.statYear))
  if (params?.entityId) q.set('entity_id', params.entityId)
  try {
    const res = await apiFetch(`/api/finance/reconcile/diff-summary?${q.toString()}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return { ok: true, batch_id: json.batch_id, kpi: json.kpi, by_type: json.by_type }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

export async function fetchFinanceReconcileDetails(params?: {
  batchId?: string
  statYear?: number
  entityId?: string
  diffType?: string
  offset?: number
  limit?: number
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  total: number
  rows: FinanceReconcileDetailRow[]
  error?: { message?: string }
}> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.statYear != null) q.set('stat_year', String(params.statYear))
  if (params?.entityId) q.set('entity_id', params.entityId)
  if (params?.diffType) q.set('diff_type', params.diffType)
  q.set('offset', String(Math.max(0, Math.floor(params?.offset ?? 0))))
  q.set('limit', String(Math.max(1, Math.min(500, Math.floor(params?.limit ?? 50)))))
  try {
    const res = await apiFetch(`/api/finance/reconcile/details?${q.toString()}`, {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, total: 0, rows: [], error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    const raw = Array.isArray(json.rows) ? json.rows : []
    return {
      ok: true,
      total: Number(json.total ?? 0),
      rows: raw.map((r: any) => ({
        diff_id: String(r?.diff_id ?? ''),
        batch_id: String(r?.batch_id ?? ''),
        tax_id: String(r?.tax_id ?? ''),
        entity_name: String(r?.entity_name ?? ''),
        stat_year: Number(r?.stat_year ?? 0),
        stat_month: r?.stat_month == null ? null : Number(r.stat_month),
        role_type: String(r?.role_type ?? ''),
        subject_code: String(r?.subject_code ?? ''),
        subject_name: String(r?.subject_name ?? ''),
        ledger_amount: r?.ledger_amount == null ? null : Number(r.ledger_amount),
        invoice_net: r?.invoice_net == null ? null : Number(r.invoice_net),
        diff_amount: Number(r?.diff_amount ?? 0),
        diff_type: String(r?.diff_type ?? ''),
        status: String(r?.status ?? ''),
      })),
    }
  } catch (e) {
    return { ok: false, total: 0, rows: [], error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}

/** 分页拉取全部差异明细（用于 CSV 导出，单次 API limit 上限 500） */
export async function fetchAllFinanceReconcileDetails(params?: {
  batchId?: string
  statYear?: number
  entityId?: string
  diffType?: string
  signal?: AbortSignal
}): Promise<{
  ok: boolean
  total: number
  rows: FinanceReconcileDetailRow[]
  error?: { message?: string }
}> {
  const pageSize = 500
  let offset = 0
  let total = 0
  const all: FinanceReconcileDetailRow[] = []
  while (true) {
    const res = await fetchFinanceReconcileDetails({
      ...params,
      offset,
      limit: pageSize,
      signal: params?.signal,
    })
    if (!res.ok) return res
    total = res.total
    all.push(...res.rows)
    if (all.length >= total || res.rows.length === 0) break
    offset += pageSize
  }
  return { ok: true, total, rows: all }
}

export type FinanceReconcileSyncFlagsResult = {
  ok: boolean
  batch_id?: string | null
  stat_year?: number | null
  analysis_batch?: string
  diff_count?: number
  inserted?: number
  skipped_confirmed?: number
  by_rule?: Record<string, number>
  error?: { message?: string; detail?: string }
}

export async function postFinanceReconcileSyncFlags(params?: {
  batchId?: string
  statYear?: number
  entityId?: string
  signal?: AbortSignal
}): Promise<FinanceReconcileSyncFlagsResult> {
  try {
    const res = await apiFetch('/api/finance/reconcile/sync-flags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch_id: params?.batchId,
        stat_year: params?.statYear,
        entity_id: params?.entityId,
      }),
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as FinanceReconcileSyncFlagsResult
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        error: json?.error ?? { message: `HTTP ${res.status}` },
      }
    }
    return json
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : '网络错误' } }
  }
}
