import type { PickedExcel } from '../components/UploadZone'
import type { ImportEvent, ImportFailPolicy, ImportFailureRecord, ImportStage } from './eventTypes'

function nowIso() {
  return new Date().toISOString()
}

function stableFail(fileName: string, sheet: string, stage: string) {
  const input = `${fileName}|${sheet}|${stage}`
  let acc = 0
  for (const ch of input) acc += ch.charCodeAt(0)
  return acc % 23 === 0
}

export type SimRunArgs = {
  import_session_id: string
  batch_date: string
  queue: PickedExcel[]
  target_sheet_keys: string[]
  fail_policy: ImportFailPolicy
  is_paused: () => boolean
  should_stop: () => boolean
  on_event: (ev: ImportEvent) => void
  on_failure: (rec: ImportFailureRecord) => void
}

export async function runSimulatedImport(args: SimRunArgs) {
  let eventId = 1
  const emit = (ev: Omit<ImportEvent, 'event_id' | 'ts' | 'import_session_id'>) => {
    args.on_event({
      ...(ev as any),
      import_session_id: args.import_session_id,
      event_id: eventId++,
      ts: nowIso(),
    })
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const waitPaused = async () => {
    while (args.is_paused()) await sleep(180)
  }

  emit({
    type: 'session_start',
    payload: {
      batch_date: args.batch_date,
      total_files: args.queue.length,
      target_sheet_keys: args.target_sheet_keys,
      fail_policy: args.fail_policy,
    },
  })

  if (args.target_sheet_keys.length === 0) {
    emit({
      type: 'session_end',
      payload: { success_files: 0, failed_files: 0, skipped_files: args.queue.length },
    })
    return
  }

  const stageOrder: ImportStage[] = ['read_excel', 'format_check', 'write_ods']
  let okFiles = 0
  let failedFiles = 0
  let skippedFiles = 0

  for (let i = 0; i < args.queue.length; i++) {
    if (args.should_stop()) break
    const row = args.queue[i]
    const f = row.file
    const file_key = `${row.pathLabel ?? ''}|${f.name}|${f.size}|${f.lastModified}`

    emit({
      type: 'file_start',
      payload: {
        file_key,
        file_name: f.name,
        path_label: row.pathLabel,
        file_size_kb: Math.round(f.size / 1024),
        file_index: i + 1,
        total_files: args.queue.length,
      },
    })

    let fileFailed = false
    const writtenSheets: string[] = []

    // Phase 1: precheck read_excel + format_check for all target sheets
    for (const sheet of args.target_sheet_keys) {
      if (fileFailed) break
      for (const stage of stageOrder) {
        if (stage === 'write_ods') continue
        await waitPaused()
        await sleep(160)

        emit({
          type: 'sheet_stage',
          payload: {
            file_key,
            file_name: f.name,
            sheet,
            stage,
            state: 'running',
          },
        })

        const fail = stableFail(f.name, sheet, stage)
        if (fail) {
          fileFailed = true
          const reason = `${sheet} · ${stage} 失败（预检）`
          emit({
            type: 'sheet_stage',
            payload: {
              file_key,
              file_name: f.name,
              sheet,
              stage,
              state: 'fail',
              message: reason,
              exception_type: 'SimulatedStageError',
            },
          })
          args.on_failure({
            file_key,
            file_name: f.name,
            sheet,
            stage,
            reason,
            exception_type: 'SimulatedStageError',
            action_taken: args.fail_policy === 'stop' ? 'stop_session' : 'skip_excel',
          })
          break
        }

        emit({
          type: 'sheet_stage',
          payload: { file_key, file_name: f.name, sheet, stage, state: 'pass' },
        })
      }
    }

    if (!fileFailed) {
      // Phase 2: write_ods for all target sheets, any fail triggers rollback semantics
      for (const sheet of args.target_sheet_keys) {
        if (fileFailed) break
        const stage: ImportStage = 'write_ods'
        await waitPaused()
        await sleep(180)

        emit({
          type: 'sheet_stage',
          payload: { file_key, file_name: f.name, sheet, stage, state: 'running' },
        })

        const fail = stableFail(f.name, sheet, stage)
        if (fail) {
          fileFailed = true
          const reason = `${sheet} · write_ods 失败（写出）`
          emit({
            type: 'sheet_stage',
            payload: {
              file_key,
              file_name: f.name,
              sheet,
              stage,
              state: 'fail',
              message: reason,
              exception_type: 'SimulatedWriteError',
            },
          })
          args.on_failure({
            file_key,
            file_name: f.name,
            sheet,
            stage,
            reason,
            exception_type: 'SimulatedWriteError',
            action_taken: args.fail_policy === 'stop' ? 'stop_session' : 'skip_excel',
          })
          break
        }

        writtenSheets.push(sheet)
        emit({
          type: 'sheet_stage',
          payload: { file_key, file_name: f.name, sheet, stage, state: 'ok' },
        })
      }
    }

    if (!fileFailed) {
      okFiles += 1
      const demoReject = (i + f.name.length) % 9 === 0 && args.target_sheet_keys.length > 0
      emit({
        type: 'file_result',
        payload: {
          file_key,
          file_name: f.name,
          file_index: i + 1,
          total_files: args.queue.length,
          result: 'success',
          rows_loaded: demoReject ? 120 : 20,
          rows_written_ods: demoReject ? 118 : 20,
          rows_dropped_within_file: demoReject ? 2 : 0,
          reject_row_ranges: demoReject
            ? [{ seq_no_start: 3, seq_no_end: 4, reason: '演示：序号缺失/无法定位' }]
            : [],
          reject_row_samples: demoReject
            ? [
                {
                  seq_no: 3,
                  sheet: args.target_sheet_keys[0],
                  field: '序号',
                  reason: '序号缺失/无法定位',
                  exception_type: 'SimulatedRowReject',
                },
              ]
            : [],
        },
      })
      continue
    }

    // failed
    if (args.fail_policy === 'stop') {
      failedFiles += 1
      emit({
        type: 'file_result',
        payload: {
          file_key,
          file_name: f.name,
          file_index: i + 1,
          total_files: args.queue.length,
          result: 'failed',
          rollback_sheets: writtenSheets,
        },
      })
      break
    }

    skippedFiles += 1
    emit({
      type: 'file_result',
      payload: {
        file_key,
        file_name: f.name,
        file_index: i + 1,
        total_files: args.queue.length,
        result: 'skipped',
        rollback_sheets: writtenSheets,
      },
    })
  }

  emit({
    type: 'session_end',
    payload: { success_files: okFiles, failed_files: failedFiles, skipped_files: skippedFiles },
  })
}

