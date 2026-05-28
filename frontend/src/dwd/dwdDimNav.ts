import type { NavKey } from '../types'

/** sessionStorage：从主体库/主体类别跳转到 DWD→DIM 时预选任务 */
export const DWD_DIM_FOCUS_TASK_KEY = 'invoicelens_dwd_dim_focus_task'

export const SUBJECT_DIM_TASK = {
  ingest: 'subject_master_ingest_from_dwd',
  recompute: 'subject_category_recompute',
  rename: 'subject_rename_signal',
  /** DWD→DIM：归集 → 重算（分类+关联）→ 更名信号，串行一键 */
  pipeline: 'subject_library_pipeline',
} as const

export type SubjectDimTaskCode = (typeof SUBJECT_DIM_TASK)[keyof typeof SUBJECT_DIM_TASK]

const VALID_FOCUS = new Set<string>(Object.values(SUBJECT_DIM_TASK))

export function readDwdDimFocusTask(): string | null {
  try {
    const raw = sessionStorage.getItem(DWD_DIM_FOCUS_TASK_KEY)
    if (!raw || !VALID_FOCUS.has(raw)) return null
    return raw
  } catch {
    return null
  }
}

export function clearDwdDimFocusTask(): void {
  try {
    sessionStorage.removeItem(DWD_DIM_FOCUS_TASK_KEY)
  } catch {
    /* ignore */
  }
}

export function navToDwdDimWithTask(onNav: (k: NavKey) => void, taskCode: SubjectDimTaskCode) {
  try {
    sessionStorage.setItem(DWD_DIM_FOCUS_TASK_KEY, taskCode)
  } catch {
    /* ignore */
  }
  onNav('dwd_to_dim_center')
}
