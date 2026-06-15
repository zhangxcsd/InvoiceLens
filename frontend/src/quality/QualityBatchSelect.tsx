import { zhCN as t } from '../copy/zh-CN'
import type { QualityImportBatch } from '../config/localApi'

const q = t.dataQualityPrototype

export function QualityBatchSelect(props: {
  batchId: string
  onBatchIdChange: (id: string) => void
  batchOptions: QualityImportBatch[]
  loading?: boolean
}) {
  return (
    <div className="flex flex-shrink-0 flex-col gap-2 sm:items-end">
      <label className="text-il-label font-medium text-text-2">{q.batchLabel}</label>
      <select
        className="min-w-[220px] rounded-sm border border-border bg-white px-2.5 py-1.5 text-il-page-desc text-text outline-none focus:border-accent disabled:opacity-60"
        value={props.batchId}
        disabled={props.loading}
        onChange={(e) => props.onBatchIdChange(e.target.value)}
      >
        <option value="">{q.batchAll}</option>
        {props.batchOptions.map((b) => (
          <option key={b.batch_id} value={b.batch_id}>
            {b.batch_id} · {b.header_count.toLocaleString('zh-CN')} {q.batchHeaderUnit}
          </option>
        ))}
      </select>
    </div>
  )
}
