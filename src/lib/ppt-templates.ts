// AI 学习助手 PPT 生成的版式（template）列表。
//
// 与服务端 src/modules/presentations/service.ts 的 PRESENTATION_TEMPLATES
// 一致（2026-11-22 对线上 Presenton 0.9.12-beta 的
// /api/v1/ppt/template/all 实测得到的 16 个内置版式，id 即小写名）。
// label 是按 Presenton 官方英文描述译的中文简称；服务端只校验 id，
// 这里改 label 不影响生成。版式只在标准模式生效，智能模式由系统自动选。
export interface PptTemplateOption {
  id: string;
  label: string;
}

export const PPT_TEMPLATES: PptTemplateOption[] = [
  { id: 'general', label: '通用（默认）' },
  { id: 'momentum', label: '动势 · 商务策略' },
  { id: 'dynamic', label: '动感 · 故事感' },
  { id: 'executive', label: '行政 · 战略决策' },
  { id: 'modern', label: '现代 · 简洁留白' },
  { id: 'standard', label: '标准 · 均衡通用' },
  { id: 'swift', label: '迅捷 · 明亮轻快' },
  { id: 'civic', label: '公共 · 政府政策' },
  { id: 'editorial', label: '杂志 · 叙事洞察' },
  { id: 'horizon', label: '地平线 · 建筑大图' },
  { id: 'landmark', label: '地标 · 建筑红调' },
  { id: 'mosaic', label: '马赛克 · 活力拼接' },
  { id: 'nova', label: '新星 · 科技未来' },
  { id: 'pulse', label: '脉冲 · 医疗研究' },
  { id: 'signal', label: '信号 · 营销增长' },
  { id: 'verdant', label: '翠绿 · 叙事绿调' },
];

export const PPT_DEFAULT_TEMPLATE = 'general';
