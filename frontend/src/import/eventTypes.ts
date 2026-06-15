export type ImportFailPolicy = 'stop' | 'skip'

export type ImportStage = 'read_excel' | 'format_check' | 'write_ods'

/** 行级拒收样本（与后端 ODS 日志字段对齐） */
export type RejectRowSample = {
  seq_no?: number | null
  sheet?: string
  field?: string
  reason?: string
  exception_type?: string
}

export type RejectRowRange = {
  seq_no_start: number
  seq_no_end: number
  reason: string
}

export type ImportEventBase = {
  import_session_id: string
  event_id: number
  ts: string
}

export type ImportEvent =
  | (ImportEventBase & {
      type: 'session_start'
      payload: {
        batch_date: string
        total_files: number
        target_sheet_keys: string[]
        fail_policy: ImportFailPolicy
        import_session_id?: string
        field_mapping_template?: {
          template_id: string
          template_name: string
          template_updated_at?: string
        }
      }
    })
  | (ImportEventBase & {
      type: 'file_start'
      payload: {
        file_key: string
        file_name: string
        path_label?: string
        file_size_kb?: number
        file_index: number
        total_files: number
      }
    })
  | (ImportEventBase & {
      type: 'sheet_stage'
      payload: {
        file_key: string
        file_name: string
        sheet: string
        stage: ImportStage
        state: 'running' | 'pass' | 'fail' | 'ok'
        message?: string
        exception_type?: string
      }
    })
  | (ImportEventBase & {
      type: 'file_result'
      payload: {
        file_key: string
        file_name: string
        /** 本次导入任务中的文件序号（从 1 开始），用于重试失败项 */
        file_index?: number
        total_files?: number
        result: 'success' | 'skipped' | 'failed'
        reason?: string
        rollback_sheets?: string[]
        exception_type?: string
        rows_loaded?: number
        rows_written_ods?: number
        rows_dropped_within_file?: number
        reject_row_ranges?: RejectRowRange[]
        reject_row_samples?: RejectRowSample[]
      }
    })
  | (ImportEventBase & {
      type: 'session_end'
      payload: {
        success_files: number
        failed_files: number
        skipped_files: number
        batch_date?: string
        import_session_id?: string
        field_mapping_template?: {
          template_id: string
          template_name: string
          template_updated_at?: string
        }
      }
    })
  | (ImportEventBase & {
      type: 'post_dwd_begin'
      payload: {
        import_batch_id: string
        import_session_id: string
        rebuild_enterprise_year_rel?: boolean
      }
    })
  | (ImportEventBase & {
      type: 'post_dwd_end'
      payload: {
        ok: boolean
        import_batch_id: string
        import_session_id: string
        stat_years_built?: number[]
        enterprise_year_rel_rebuild?: Record<string, unknown>
        error?: { message?: string }
      }
    })

export type ImportFailureRecord = {
  file_key: string
  file_name: string
  sheet?: string
  stage?: ImportStage
  reason: string
  exception_type?: string
  action_taken: 'stop_session' | 'skip_excel'
}

