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

/** React 依赖重跑 / 卸载时 AbortController 取消 fetch，不应当作业务错误展示 */
function isFetchAbortError(e: unknown): boolean {
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
  const res = await fetch(apiUrl('/api/import-limits'), { signal })
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
    const res = await fetch(apiUrl('/api/header-coverage'), {
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
    const res = await fetch(apiUrl('/api/field-mapping'), { signal })
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

/** 任务码 dim.enterprise_year_rel.rebuild：按集团台账成员 × DWD 按年重算 dim_enterprise_year_rel */
export type EnterpriseYearRelMetaResult = {
  ok: boolean
  automation_task_code?: string
  dwd_stat_years?: string[]
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
  },
  signal?: AbortSignal,
): Promise<DwdBuildResult & { httpStatus: number }> {
  const res = await fetch(apiUrl('/api/dwd/build'), {
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
  },
  signal?: AbortSignal,
): Promise<DwdBuildResult & { httpStatus: number; force_rebuild?: boolean; import_session_id?: string }> {
  const res = await fetch(apiUrl('/api/dwd/force-rebuild'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      import_batch_id: params.import_batch_id,
      import_session_id: params.import_session_id,
      ...(params.stat_year != null ? { stat_year: params.stat_year } : {}),
      ...(params.rebuild_enterprise_year_rel === true ? { rebuild_enterprise_year_rel: true } : {}),
    }),
    signal,
  })
  const json = (await res.json().catch(() => ({}))) as DwdBuildResult & {
    force_rebuild?: boolean
    import_session_id?: string
  }
  return { ...json, httpStatus: res.status }
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
  const res = await fetch(apiUrl('/api/dim/build-enterprise-profile'), {
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
  const res = await fetch(apiUrl('/api/dim/build-enterprise-master'), {
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
  const res = await fetch(apiUrl('/api/dim/build-enterprise-mapping'), {
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
  const res = await fetch(apiUrl('/api/dim/enterprise-year-rel/meta'), { signal })
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
  const res = await fetch(apiUrl('/api/dim/enterprise-year-rel/rebuild'), {
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
  const res = await fetch(apiUrl('/api/dim/tasks'), { signal })
  const json = (await res.json().catch(() => ({}))) as DimTasksResponse
  return { ...json, httpStatus: res.status }
}

/** GET /api/dim/task-run-status?run_id= */
export async function fetchDimTaskRunStatus(
  runId: string,
  signal?: AbortSignal,
): Promise<DimTaskRunStatusResponse & { httpStatus: number }> {
  const qs = new URLSearchParams({ run_id: runId })
  const res = await fetch(apiUrl(`/api/dim/task-run-status?${qs.toString()}`), { signal })
  const json = (await res.json().catch(() => ({}))) as DimTaskRunStatusResponse
  return { ...json, httpStatus: res.status }
}

/** POST /api/subject-library/pipeline：主体库一键全流程（后台） */
export async function postSubjectLibraryPipeline(
  params: { overwrite_manual_repairs?: boolean; with_relations?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ ok: boolean; async?: boolean; run_id?: string; message?: string; error?: { message?: string } }> {
  const res = await fetch(apiUrl('/api/subject-library/pipeline'), {
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
  const res = await fetch(apiUrl(`/api/subject-library/pipeline-status?${qs.toString()}`), { signal })
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
    const res = await fetch(apiUrl('/api/field-mapping'), {
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
    if (importSessionId) fd.append('import_session_id', importSessionId)
    fd.append('files', row.file, row.file.name)

    const res = await fetch(apiUrl('/api/import-sessions/upload-file'), {
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
    const res = await fetch(apiUrl(`/api/ods-preview/batches?limit=${limit}`), { signal })
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
    const res = await fetch(apiUrl(`/api/ods-preview/session?${q}`), { signal })
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
    const res = await fetch(apiUrl(`/api/ods-preview/table-page?${q}`), { signal })
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
    const res = await fetch(apiUrl(`/api/dwd-preview/tabs?${q}`), { signal })
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
    const res = await fetch(apiUrl(`/api/dwd-preview/table-page?${q}`), { signal })
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
    const res = await fetch(apiUrl('/api/dwd-preview/delete'), {
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
    const res = await fetch(apiUrl('/api/ods-preview/delete'), {
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
  overview?: {
    total_score: number
    grade: string
    change_vs_prev: number
    score_formula: string
    grade_rule: string
  }
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
  signal?: AbortSignal
}): Promise<HealthScoreSnapshot> {
  const q = new URLSearchParams()
  if (params?.batchId) q.set('batch_id', params.batchId)
  if (params?.sessionId) q.set('session_id', params.sessionId)
  try {
    const res = await fetch(apiUrl(`/api/quality/health-score?${q.toString()}`), {
      signal: params?.signal,
    })
    const json = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? { message: `HTTP ${res.status}` } }
    }
    return {
      ok: true,
      rule_version: json.rule_version != null ? String(json.rule_version) : undefined,
      overview: json.overview,
      dimensions: Array.isArray(json.dimensions) ? json.dimensions : [],
      indicators: Array.isArray(json.indicators) ? json.indicators : [],
      top_deductions: Array.isArray(json.top_deductions) ? json.top_deductions : [],
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
    const res = await fetch(apiUrl(`/api/quality/red-invoice-overview?${q.toString()}`), {
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
    const res = await fetch(apiUrl(`/api/quality/red-invoice-details?${q.toString()}`), {
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
    const res = await fetch(apiUrl('/api/quality/red-invoice-parse'), {
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
      res = await fetch(apiUrl('/api/dim-tax-code/import'), {
        method: 'POST',
        body: fd,
        signal: params.signal,
      })
    } else {
      res = await fetch(apiUrl('/api/dim-tax-code/import'), {
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
    const res = await fetch(apiUrl(`/api/dim-tax-code/rows?${sp.toString()}`), { signal: params.signal })
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
    const res = await fetch(apiUrl(`/api/dim-tax-code/filter-options${qs ? `?${qs}` : ''}`), {
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
    const res = await fetch(apiUrl('/api/dim-tax-code/reapply-risk-rules'), {
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
    const res = await fetch(apiUrl('/api/dim-tax-code/risk-rules'), { signal })
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
    const res = await fetch(apiUrl('/api/dim-tax-code/risk-rules'), {
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
    const res = await fetch(apiUrl('/api/subject-category/recompute/latest'), { signal })
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
    const res = await fetch(apiUrl('/api/subject-library/ingest-from-dwd'), {
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
    const res = await fetch(apiUrl('/api/subject-library/import-external'), {
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
    const res = await fetch(apiUrl('/api/subject-library/repair'), {
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
    const res = await fetch(apiUrl('/api/subject-category/recompute'), {
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
    const res = await fetch(apiUrl('/api/dim/group-enterprise-year/rebuild'), {
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
    const res = await fetch(apiUrl('/api/subject-library/org-category-options'), { signal })
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
    const res = await fetch(apiUrl(`/api/subject-library/summary?${sp.toString()}`), { signal: params.signal })
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
    const res = await fetch(apiUrl(`/api/subject-library/rows?${sp.toString()}`), { signal: params.signal })
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
    const res = await fetch(apiUrl('/api/subject-library/rebuild-rename-signals'), {
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
    const res = await fetch(apiUrl(`/api/subject-library/rename-rebuild-status?${sp.toString()}`), {
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
    const res = await fetch(apiUrl(`/api/subject-library/invoice-headers?${sp.toString()}`), {
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
    const res = await fetch(apiUrl(`/api/subject-library/rename-timeline?${sp.toString()}`), { signal })
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
  /** dim_group_enterprise_year 中 level1_group_id 匹配的成员总数 */
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
    const res = await fetch(apiUrl(`/api/dim/enterprise-year-roster/bootstrap?${sp.toString()}`), { signal })
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
    const res = await fetch(apiUrl(`/api/dim/enterprise-year-roster/kpi?${sp.toString()}`), { signal })
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
    const res = await fetch(apiUrl('/api/dim/enterprise-year-roster/meta'), { signal })
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
    const res = await fetch(apiUrl(`/api/dim/enterprise-year-roster/summary?${sp.toString()}`), { signal })
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
  sp.set('limit', String(params.limit ?? 50))
  sp.set('offset', String(params.offset ?? 0))
  try {
    const res = await fetch(apiUrl(`/api/dim/enterprise-year-roster/list?${sp.toString()}`), { signal })
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
    const res = await fetch(apiUrl('/api/dim/enterprise-year-roster/rebuild'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stat_years: body.statYears,
        replace_years: body.replaceYears ?? true,
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
    const res = await fetch(apiUrl(`/api/dim/level1-enterprise-year/members?${sp.toString()}`), { signal })
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
    const res = await fetch(apiUrl('/api/dim/level1-enterprise-year/meta'), { signal })
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
    const res = await fetch(apiUrl(`/api/dim/level1-enterprise-year/list?${sp.toString()}`), { signal })
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
    const res = await fetch(apiUrl(`/api/dim/level1-enterprise-year/candidates?${sp.toString()}`), { signal })
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
    const res = await fetch(apiUrl('/api/dim/level1-enterprise-year/upsert'), {
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
    const res = await fetch(apiUrl('/api/dim/level1-enterprise-year/delete'), {
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
    const res = await fetch(apiUrl('/api/dim/level1-enterprise-year/import-batch'), {
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
    const res = await fetch(apiUrl('/api/dim/level1-enterprise-year/preview-from-previous'), {
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
    const res = await fetch(apiUrl('/api/dim/level1-enterprise-year/copy-from-previous'), {
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
    const res = await fetch(apiUrl('/api/audited-enterprise/registry/meta'), { signal })
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
    const res = await fetch(apiUrl(`/api/audited-enterprise/registry?${sp.toString()}`), { signal })
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
    const res = await fetch(apiUrl('/api/audited-enterprise/registry'), {
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
    const res = await fetch(apiUrl('/api/audited-enterprise/registry/bootstrap-demo'), {
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
    const res = await fetch(apiUrl(`/api/audited-enterprise/contribution?${sp.toString()}`), { signal })
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
    const res = await fetch(apiUrl('/api/audited-enterprise/contribution'), {
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
    const res = await fetch(apiUrl('/api/audited-enterprise/contribution/bootstrap-demo'), {
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
    const res = await fetch(apiUrl(`/api/audited-enterprise/invoice-link?${sp.toString()}`), { signal })
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
  level1_stat_years?: string[]
  hint?: string
  error?: { message?: string; exception_type?: string }
}> {
  try {
    const res = await fetch(apiUrl('/api/invoice-coverage/meta'), { signal })
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
      level1_stat_years: toYearList('level1_stat_years'),
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
    const res = await fetch(apiUrl(`/api/invoice-coverage/soe-options?${sp.toString()}`), { signal })
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
    const res = await fetch(apiUrl(`/api/invoice-coverage/summary?${sp.toString()}`), { signal })
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
    listView: 'unreported' | 'reported' | 'all'
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
    const res = await fetch(apiUrl(`/api/invoice-coverage/members?${sp.toString()}`), { signal })
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
