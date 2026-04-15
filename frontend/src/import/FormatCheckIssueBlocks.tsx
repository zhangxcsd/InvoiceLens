import { zhCN as t } from '../copy/zh-CN'

export function FormatCheckIssueBlocks(props: {
  browserIssues: string[]
  yamlIssues: string[]
}) {
  const { browserIssues, yamlIssues } = props
  if (browserIssues.length === 0 && yamlIssues.length === 0) return null

  return (
    <div className="mb-4 shrink-0 space-y-3">
      {browserIssues.length > 0 ? (
        <div className="rounded-[8px] border border-danger/35 bg-[#fff8f8] p-3">
          <div className="mb-2 text-il-btn font-semibold text-danger">
            {t.importUpload.formatCheckBlockStructure}
          </div>
          <ul className="max-h-52 list-disc space-y-1.5 overflow-y-auto pl-5 text-il-meta leading-relaxed text-text-2">
            {browserIssues.map((x, i) => (
              <li key={`fmt-${i}`}>{x}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {yamlIssues.length > 0 ? (
        <div className="rounded-[8px] border border-[#d4b84a]/55 bg-[#fffdf6] p-3">
          <div className="mb-2 text-il-btn font-semibold text-[#7a5f00]">
            {t.importUpload.formatCheckBlockYaml}
          </div>
          <ul className="max-h-52 list-disc space-y-1.5 overflow-y-auto pl-5 text-il-meta leading-relaxed text-text-2">
            {yamlIssues.map((x, i) => (
              <li key={`yaml-${i}`}>{x}</li>
            ))}
          </ul>
          <div className="mt-2 border-t border-[#e8dcb0]/80 pt-2 text-il-meta text-text-3">
            {t.importUpload.formatCheckYamlHelp}
          </div>
        </div>
      ) : null}
    </div>
  )
}
