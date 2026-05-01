import { zhCN as t } from '../../copy/zh-CN'

type Ui = typeof t.dimVersionUi

export function VersionActionBar(props: {
  ui: Ui
  canPublish: boolean
  canRollback: boolean
  canArchive: boolean
  onSaveDraft: () => void
  onPublish: () => void
  onRollback: () => void
  onArchive: () => void
  onExport: () => void
}) {
  const { ui, canPublish, canRollback, canArchive, onSaveDraft, onPublish, onRollback, onArchive, onExport } = props
  return (
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <button
        type="button"
        className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-page-desc text-text hover:bg-[#f8fafc]"
        onClick={onSaveDraft}
      >
        {ui.saveDraftBtn}
      </button>
      <button
        type="button"
        className={[
          'rounded-sm border px-3 py-1.5 text-il-page-desc',
          canPublish ? 'border-[#c8dff7] bg-[#f0f7ff] text-accent hover:opacity-90' : 'cursor-not-allowed border-border-light bg-[#f5f7fa] text-text-3',
        ].join(' ')}
        disabled={!canPublish}
        onClick={onPublish}
      >
        {ui.publishBtn}
      </button>
      <button
        type="button"
        className={[
          'rounded-sm border px-3 py-1.5 text-il-page-desc',
          canRollback ? 'border-border-light bg-white text-text hover:bg-[#f8fafc]' : 'cursor-not-allowed border-border-light bg-[#f5f7fa] text-text-3',
        ].join(' ')}
        disabled={!canRollback}
        onClick={onRollback}
      >
        {ui.rollbackBtn}
      </button>
      <button
        type="button"
        className={[
          'rounded-sm border px-3 py-1.5 text-il-page-desc',
          canArchive ? 'border-border-light bg-white text-text hover:bg-[#f8fafc]' : 'cursor-not-allowed border-border-light bg-[#f5f7fa] text-text-3',
        ].join(' ')}
        disabled={!canArchive}
        onClick={onArchive}
      >
        {ui.archiveBtn}
      </button>
      <button
        type="button"
        className="rounded-sm border border-border-light bg-white px-3 py-1.5 text-il-page-desc text-text hover:bg-[#f8fafc]"
        onClick={onExport}
      >
        {ui.exportBtn}
      </button>
    </div>
  )
}
