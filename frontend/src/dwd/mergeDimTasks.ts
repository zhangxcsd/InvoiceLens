import type { DimTasksResponse, DimUnifiedTaskRow } from '../config/localApi'
import dimTaskCatalog from '../../../config/dim_task_catalog.json'

export type DimTaskCatalogRow = DimUnifiedTaskRow & {
  task_no: number
  query_group?: string
  query_group_label?: string
}

/** 与 config/dim_task_catalog.json 对齐；API 不可用时仍能展示编号与说明 */
export const DIM_TASK_CATALOG: DimTaskCatalogRow[] = dimTaskCatalog as DimTaskCatalogRow[]

export function catalogByCode(): Record<string, DimTaskCatalogRow> {
  const out: Record<string, DimTaskCatalogRow> = {}
  for (const row of DIM_TASK_CATALOG) {
    const code = String(row.task_code ?? '').trim()
    if (code) out[code] = row
  }
  return out
}

/** 以注册表为基准合并运行态；保证 task_no / purpose 等元数据始终存在 */
export function pickDimTaskRegistry(
  response: Pick<DimTasksResponse, 'registry' | 'tasks'> & Partial<DimTasksResponse>,
): DimTaskCatalogRow[] {
  const fromApi = response.registry
  if (Array.isArray(fromApi) && fromApi.length > 0) {
    return fromApi.map((row) => ({ ...catalogByCode()[String(row.task_code ?? '')], ...row })) as DimTaskCatalogRow[]
  }
  return DIM_TASK_CATALOG
}

export function liveStatusByCode(tasks: DimUnifiedTaskRow[] | undefined): Record<string, DimUnifiedTaskRow> {
  const out: Record<string, DimUnifiedTaskRow> = {}
  for (const row of tasks ?? []) {
    const code = String(row.task_code ?? '').trim()
    if (code) out[code] = row
  }
  return out
}

export function mergeDimTaskRows(
  response: Pick<DimTasksResponse, 'registry' | 'tasks'> & Partial<DimTasksResponse>,
): DimTaskCatalogRow[] {
  const registry = pickDimTaskRegistry(response)
  const live = liveStatusByCode(response.tasks)
  return registry
    .slice()
    .sort((a, b) => Number(a.task_no ?? 0) - Number(b.task_no ?? 0))
    .map((reg) => {
      const code = String(reg.task_code ?? '').trim()
      const statusRow = code ? live[code] : undefined
      return { ...reg, ...statusRow } as DimTaskCatalogRow
    })
}
