const RULE_META_KEYS = new Set(['enabled', 'name', 'description', 'logic'])

export type CategoryTaxMapEntry = { keywords: string[]; expected_rate: number }

function findRuleBlockRange(lines: string[], ruleId: string): { start: number; end: number } | null {
  const header = `  ${ruleId}:`
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === header) {
      start = i + 1
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

function parseYamlStringArray(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[')) return []
  try {
    const parsed = JSON.parse(trimmed.replace(/'/g, '"')) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    const inner = trimmed.slice(1, -1)
    if (!inner.trim()) return []
    return inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
  }
}

function parseYamlScalar(raw: string): string | number | boolean {
  const v = raw.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

function skipMultilineBlock(lines: string[], i: number, end: number): number {
  let j = i + 1
  while (j < end && !/^    [a-zA-Z_]/.test(lines[j]!)) j++
  return j
}

function parseCategoryTaxMapLines(lines: string[], start: number, end: number): CategoryTaxMapEntry[] {
  const entries: CategoryTaxMapEntry[] = []
  let i = start
  while (i < end) {
    const line = lines[i]!
    if (/^    [a-zA-Z_]/.test(line)) break
    const itemMatch = line.match(/^      - keywords:\s*(.+)$/)
    if (itemMatch) {
      const keywords = parseYamlStringArray(itemMatch[1]!)
      let expected_rate = 0
      const next = lines[i + 1]
      if (next) {
        const rateMatch = next.match(/^        expected_rate:\s*(.+)$/)
        if (rateMatch) {
          expected_rate = Number(rateMatch[1])
          i += 2
          entries.push({ keywords, expected_rate })
          continue
        }
      }
      entries.push({ keywords, expected_rate: 0 })
    }
    i++
  }
  return entries
}

/** 从 YAML 文本解析指定规则的可调参数（不含 enabled/name/description/logic）。 */
export function parseRuleParamsFromYaml(yamlText: string, ruleId: string): Record<string, unknown> {
  const lines = yamlText.split('\n')
  const range = findRuleBlockRange(lines, ruleId)
  if (!range) return {}

  const params: Record<string, unknown> = {}
  let i = range.start
  while (i < range.end) {
    const line = lines[i]!
    const keyMatch = line.match(/^    ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/)
    if (!keyMatch) {
      i++
      continue
    }
    const key = keyMatch[1]!
    const rest = keyMatch[2]!.trim()
    if (RULE_META_KEYS.has(key)) {
      if (rest === '>' || rest === '|' || rest === '') i = skipMultilineBlock(lines, i, range.end)
      else i++
      continue
    }
    if (key === 'category_tax_map') {
      params[key] = parseCategoryTaxMapLines(lines, i + 1, range.end)
      i++
      while (i < range.end && !/^    [a-zA-Z_]/.test(lines[i]!)) i++
      continue
    }
    if (rest === '>' || rest === '|' || rest === '') {
      i = skipMultilineBlock(lines, i, range.end)
      continue
    }
    params[key] = parseYamlScalar(rest)
    i++
  }
  return params
}

function formatYamlScalar(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (/^[\w\u4e00-\u9fff-]+$/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 在 audit_rules.yaml 文本中切换指定规则的 enabled 字段（保持其余格式不变）。 */
export function patchRuleEnabledInYaml(yamlText: string, ruleId: string, enabled: boolean): string {
  const lines = yamlText.split('\n')
  const ruleHeader = `  ${ruleId}:`
  let inTarget = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
      inTarget = line === ruleHeader
      continue
    }
    if (inTarget && /^    enabled:\s*(true|false)\s*(#.*)?$/.test(line)) {
      const comment = line.match(/(#.*)$/)?.[1] ?? ''
      lines[i] = `    enabled: ${enabled}${comment ? ` ${comment}` : ''}`
      return lines.join('\n')
    }
  }
  return yamlText
}

/** 更新规则块内单个标量参数（保留行内注释）。 */
export function patchRuleScalarInYaml(
  yamlText: string,
  ruleId: string,
  key: string,
  value: string | number | boolean,
): string {
  const lines = yamlText.split('\n')
  const range = findRuleBlockRange(lines, ruleId)
  if (!range) return yamlText

  const formatted = formatYamlScalar(value)
  const prefix = `    ${key}:`
  for (let i = range.start; i < range.end; i++) {
    if (lines[i]!.startsWith(prefix)) {
      const comment = lines[i]!.match(/(#.*)$/)?.[1] ?? ''
      lines[i] = `${prefix} ${formatted}${comment ? ` ${comment}` : ''}`
      return lines.join('\n')
    }
  }
  lines.splice(range.end, 0, `${prefix} ${formatted}`)
  return lines.join('\n')
}

/** 替换 category_tax_map 整段列表。 */
export function patchCategoryTaxMapInYaml(
  yamlText: string,
  ruleId: string,
  entries: CategoryTaxMapEntry[],
): string {
  const lines = yamlText.split('\n')
  const range = findRuleBlockRange(lines, ruleId)
  if (!range) return yamlText

  const newLines = [
    '    category_tax_map:',
    ...entries.flatMap((e) => [
      `      - keywords: [${e.keywords.map((k) => `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ')}]`,
      `        expected_rate: ${e.expected_rate}`,
    ]),
  ]

  let mapStart = -1
  let mapEnd = range.end
  for (let i = range.start; i < range.end; i++) {
    if (/^    category_tax_map:\s*$/.test(lines[i]!)) {
      mapStart = i
      for (let j = i + 1; j < range.end; j++) {
        if (/^    [a-zA-Z_]/.test(lines[j]!)) {
          mapEnd = j
          break
        }
      }
      break
    }
  }

  if (mapStart >= 0) lines.splice(mapStart, mapEnd - mapStart, ...newLines)
  else lines.splice(range.end, 0, ...newLines)
  return lines.join('\n')
}

export function inferParamEditorKind(key: string, value: unknown): 'risk' | 'bool' | 'number' | 'category_tax_map' | 'text' {
  if (key === 'category_tax_map') return 'category_tax_map'
  if (key.startsWith('risk_level')) return 'risk'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return 'number'
  if (value === 'true' || value === 'false') return 'bool'
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return 'number'
  if (key.startsWith('use_')) return 'bool'
  return 'text'
}
