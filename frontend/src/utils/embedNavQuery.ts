/** 嵌入分析容器时覆盖 URL 深链参数（避免与疑点清单页筛选 query 冲突）。 */
let activeEmbedQuery: Record<string, string> | null = null

export function setActiveEmbedNavQuery(query: Record<string, string> | null) {
  activeEmbedQuery = query
}

export function getEmbedNavQuery(): Record<string, string> | null {
  return activeEmbedQuery
}

export function readEffectiveNavQuery(fallback: () => Record<string, string>): Record<string, string> {
  if (activeEmbedQuery) return { ...activeEmbedQuery }
  return fallback()
}
