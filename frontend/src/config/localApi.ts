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
    }),
    signal,
  })
  const json = (await res.json().catch(() => ({}))) as DwdBuildResult
  return { ...json, httpStatus: res.status }
}

/** POST /api/dwd/force-rebuild：运维强制重洗（删 DWD 行 + 重置水位 + 重跑） */
export async function postDwdForceRebuild(
  params: { import_batch_id: string; import_session_id: string; stat_year?: number },
  signal?: AbortSignal,
): Promise<DwdBuildResult & { httpStatus: number; force_rebuild?: boolean; import_session_id?: string }> {
  const res = await fetch(apiUrl('/api/dwd/force-rebuild'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      import_batch_id: params.import_batch_id,
      import_session_id: params.import_session_id,
      ...(params.stat_year != null ? { stat_year: params.stat_year } : {}),
    }),
    signal,
  })
  const json = (await res.json().catch(() => ({}))) as DwdBuildResult & {
    force_rebuild?: boolean
    import_session_id?: string
  }
  return { ...json, httpStatus: res.status }
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
  signal?: AbortSignal
  /** 每成功上传一个文件后回调（done 从 1 递增；亦可用于 UI 显示 0/total 由调用方在调用前自行展示） */
  onUploadProgress?: (done: number, total: number) => void
}): Promise<string> {
  const { batchDate, failPolicy, forceReimport, targetSheetKeys, maxUploadMb, files, signal, onUploadProgress } = params
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
      body: '{}',
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
  table_type: string
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
    const tabs: DwdPreviewTabMeta[] = raw
      .map((t: any) => ({
        table_type: String(t?.table_type ?? '').trim(),
        title: String(t?.title ?? t?.table_type ?? '').trim(),
        layer: t?.layer === 'header' ? 'header' : 'detail',
        row_count: Number(t?.row_count ?? 0),
      }))
      .filter((t: DwdPreviewTabMeta) => t.table_type.length > 0)
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
  /** 与 ODS Tab 对齐；指定时优先于 layer */
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
  const { batchId, sessionId, tableType, layer = 'detail', limit = 200, cursor, signal } = params
  const q = new URLSearchParams({
    batch_id: batchId,
    session_id: sessionId,
    layer,
    limit: String(Math.max(1, Math.min(500, Math.floor(limit)))),
  })
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

