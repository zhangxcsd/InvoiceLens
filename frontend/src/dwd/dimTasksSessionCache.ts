import type { DimTasksResponse } from '../config/localApi'
import { DIM_TASK_CATALOG, mergeDimTaskRows, type DimTaskCatalogRow } from './mergeDimTasks'

const STATIC_CATALOG_RESPONSE: Pick<DimTasksResponse, 'ok' | 'tasks' | 'registry'> = {
  ok: false,
  tasks: [],
  registry: DIM_TASK_CATALOG,
}

/** 本地注册表任务行（无运行态），用于首屏即时渲染 */
export function buildCatalogTaskRows(): DimTaskCatalogRow[] {
  return mergeDimTaskRows(STATIC_CATALOG_RESPONSE)
}

export function defaultDimTaskCode(rows: DimTaskCatalogRow[] = buildCatalogTaskRows()): string {
  return String(rows[0]?.task_code ?? '').trim()
}

let sessionTasksCache: DimTasksResponse | null = null

export function readDimTasksSessionCache(): DimTasksResponse | null {
  return sessionTasksCache
}

export function writeDimTasksSessionCache(data: DimTasksResponse): void {
  if (data?.ok) sessionTasksCache = data
}

type RunLogRow = {
  run_id: string
  status: string
  rows_affected: number
  started_at: string
  duration_ms: number
  error_message: string
}

const runLogsByTask = new Map<string, RunLogRow[]>()

export function readDimRunLogsCache(taskCode: string): RunLogRow[] | null {
  const code = taskCode.trim()
  if (!code) return null
  return runLogsByTask.get(code) ?? null
}

export function writeDimRunLogsCache(taskCode: string, rows: RunLogRow[]): void {
  const code = taskCode.trim()
  if (!code) return
  runLogsByTask.set(code, rows)
}
