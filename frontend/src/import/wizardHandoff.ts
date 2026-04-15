import type { PickedExcel } from '../components/UploadZone'

/**
 * 从「格式检测」页带入「文件上传」：队列、目标 Sheet、单文件上限（与检测时一致）。
 * `targetSheetKeys` 为**已通过格式检测**的 Sheet 范围；上传页仅允许在该集合内**缩小**勾选，不得扩大，避免未检测的 Sheet 进入导入。
 */
export type ImportWizardHandoff = {
  queue: PickedExcel[]
  targetSheetKeys: string[]
  maxUploadMb: number
}
