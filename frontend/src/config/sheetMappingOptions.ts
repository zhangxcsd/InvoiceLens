/**
 * 前端兜底的静态候选列表（当本地 API 不可用时使用）。
 *
 * 真实候选项应来自本机 `config/sheet_mapping.yaml`：
 * - 由本地 API `GET /api/sheet-mapping` 返回
 * - 前端启动时拉取一次，可手动刷新
 */
export const sheetMappingOptionsFallback = [
  '发票基础信息',
  '信息汇总表',
  '货物清单',
  '不动产销售',
  '机动车销售',
  '二手车销售',
  '拖拉机',
  '成品油',
  '稀土',
  '农产品收购',
  '自产农产品',
  '光伏',
  '报废产品收购',
  '无形资产',
  '建筑服务',
  '金融服务',
  '现代服务',
  '生活服务',
  '医疗服务',
  '通行费',
  '不动产经营租赁',
  '有形动产租赁',
  '货物运输服务',
  '旅客运输服务',
  '铁路电子客票',
  '铁路客票',
  '航空运输',
  '车船税',
  '差额征税',
  '代开发票',
] as const

export const defaultTargetSheetKeysFallback = [...sheetMappingOptionsFallback] as unknown as string[]

