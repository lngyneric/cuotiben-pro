// PPT 版式注册表 + 主题与 Logo —— 阶段 0 地基（实施清单“共通规范”）。
//
// 单一事实来源：主题 8 色、Logo 位、字体、版式 A–H 的槽位定义只在这里
// 出现。生成（service.ts 的 buildThemeInstructions）、放图（阶段 1）、
// 放图表与单页编辑（阶段 2/3）都引用同一组常量，不各自硬编码另一套颜色。
//
// 槽位几何的来源：设计稿 ~/workspace/your_files/PPT模板设计稿-版式确认.pptx
// （9 页，13.33×7.5 英寸），用 python-pptx 实测每个占位框的坐标后抄入，
// 不是凭空编的。rect 用英寸表示（设计稿的原始单位），fractions 由它导出。
// 页眉（标题/副标题/分隔线）与 Logo 位全版式统一，见 COMMON_SLOTS /
// PPT_LOGO_SLOT，不在每个版式里重复写。
//
// Presenton 的限制（实测 service.ts 的调用方式）：generate/async 与
// create 接口都不接受主题色或 Logo 参数，只接受 instructions 文本。
// 所以主题与 Logo 的注入只能走提示词级：在生成请求的 instructions 里
// 追加 buildThemeInstructions() 的文本块，并把主题版本写进任务行
// （themeVersion）。这不是“Presenton 支持主题参数”——它不支持，注入
// 是提示词级的，成稿配色仍以 Presenton 实际出稿为准，阶段 0 只保证
// 请求侧每次都带同一份主题描述。

export const PPT_THEME_VERSION = '2026-11-v2';

/** 主题 8 色（设计稿总览页为准，实施清单封面页清单一致）。 */
export const PPT_THEME_COLORS = {
  /** 标题蓝 */
  titleBlue: '#2F5597',
  /** 深海军蓝（数据条底） */
  deepNavy: '#003266',
  /** 亮蓝 */
  brightBlue: '#005B9F',
  /** 绿 */
  green: '#27AE60',
  /** 橙 */
  orange: '#ED7D31',
  /** 浅蓝 */
  lightBlue: '#9DC3E6',
  /** 分隔灰蓝 */
  dividerGrayBlue: '#D9DEE6',
  /** 卡片底 */
  cardBg: '#F7F9FC',
} as const;
export type PptThemeColorName = keyof typeof PPT_THEME_COLORS;

/** 字体（设计稿总览页）。 */
export const PPT_THEME_FONTS = {
  title: '标题 32pt 加粗 #2F5597',
  subtitle: '副标题 14pt 加粗 #333333',
  cardTitle: '卡片标题 17pt 加粗 #003266',
  body: '正文 13.5pt #333333',
  kpiNumber: '数据数字 26pt 加粗 白色',
  caption: '说明文字 10–12pt #666666',
} as const;

/** 幻灯片尺寸（英寸，设计稿实测 13.33×7.5）。 */
export const PPT_SLIDE_SIZE_IN = { width: 13.33, height: 7.5 } as const;

/** Logo 位：右上角固定矩形（英寸）。Logo 已嵌在 sysmex 模板里（见
 * presenton-templates/），此处只给主题指令写位置用，不再用于上传。 */
export const PPT_LOGO_SLOT = {
  x: 11.55,
  y: 0.12,
  width: 1.48,
  height: 0.52,
} as const;

export interface SlotRectIn {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 槽位在页内的比例位置（0–1），由英寸 rect 导出，供阶段 1/2/3 定位用。 */
export interface SlotRectFrac {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SlotType =
  | 'title'
  | 'body'
  | 'main_image'
  | 'small_image'
  | 'kpi_card'
  | 'chart';

// 图片槽位（main_image / small_image）的单次任务引用上限沿用附件约束
// （每次最多 5 个文件、其中截图最多 3 张，2026-11-25 用户定），校验在
// 阶段 1 实现；注册表本身不限数量，只定义槽位。图表槽位（chart）是类型
// 占位，供阶段 3 用，设计稿 A–H 里没有图表槽位。

export const SLOT_TYPES: readonly SlotType[] = [
  'title',
  'body',
  'main_image',
  'small_image',
  'kpi_card',
  'chart',
] as const;

export interface LayoutSlot {
  id: string;
  type: SlotType;
  /** 英寸 rect（设计稿原始坐标）。 */
  rectIn: SlotRectIn;
  /** 比例 rect（由 rectIn 导出）。 */
  rect: SlotRectFrac;
  /** 阶段 1 可空出、阶段 2 可删的槽位（如 F 的配图条）。 */
  optional?: boolean;
}

export type LayoutCode = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

export interface LayoutDefinition {
  code: LayoutCode;
  name: string;
  use: string;
  slots: LayoutSlot[];
}

function slot(
  id: string,
  type: SlotType,
  x: number,
  y: number,
  width: number,
  height: number,
  optional = false
): LayoutSlot {
  const round4 = (n: number) => Math.round(n * 10000) / 10000;
  return {
    id,
    type,
    rectIn: { x, y, width, height },
    rect: {
      x: round4(x / PPT_SLIDE_SIZE_IN.width),
      y: round4(y / PPT_SLIDE_SIZE_IN.height),
      width: round4(width / PPT_SLIDE_SIZE_IN.width),
      height: round4(height / PPT_SLIDE_SIZE_IN.height),
    },
    ...(optional ? { optional: true } : {}),
  };
}

/** 全版式统一的页眉槽位（标题区不压 Logo：标题宽 10.50，Logo 从 11.55 起）。 */
export const COMMON_SLOTS: LayoutSlot[] = [
  slot('header_title', 'title', 0.3, 0.05, 10.5, 0.64),
  slot('header_subtitle', 'body', 0.3, 0.68, 12.73, 0.32),
];

export const LAYOUTS: Record<LayoutCode, LayoutDefinition> = {
  A: {
    code: 'A',
    name: '数据条+四卡',
    use: '一页讲清多个亮点+关键数字（现有 11 月第 1 页结构）',
    slots: [
      slot('kpi_1', 'kpi_card', 0.55, 1.44, 2.6, 1.14),
      slot('kpi_2', 'kpi_card', 3.8, 1.44, 2.6, 1.14),
      slot('kpi_3', 'kpi_card', 7.25, 1.44, 2.6, 1.14),
      slot('card_1_title', 'title', 0.52, 3.12, 2.62, 0.45),
      slot('card_1_body', 'body', 0.52, 3.93, 2.62, 1.47),
      slot('card_2_title', 'title', 3.74, 3.12, 2.62, 0.45),
      slot('card_2_body', 'body', 3.74, 3.93, 2.62, 1.47),
      slot('card_3_title', 'title', 6.97, 3.12, 2.62, 0.45),
      slot('card_3_body', 'body', 6.97, 3.93, 2.62, 1.47),
      slot('card_4_title', 'title', 10.19, 3.12, 2.62, 0.45),
      slot('card_4_body', 'body', 10.19, 3.93, 2.62, 1.47),
    ],
  },
  B: {
    code: 'B',
    name: '左文右图',
    use: '步骤说明+一张主图（现有 11 月第 2 页结构）',
    slots: [
      slot('step_1_title', 'title', 0.55, 1.85, 6.8, 0.4),
      slot('step_1_body', 'body', 0.55, 2.3, 6.8, 1.0),
      slot('step_2_title', 'title', 0.55, 3.55, 6.8, 0.4),
      slot('step_2_body', 'body', 0.55, 4.0, 6.8, 1.0),
      slot('step_3_title', 'title', 0.55, 5.25, 6.8, 0.4),
      slot('step_3_body', 'body', 0.55, 5.7, 6.8, 1.0),
      slot('main_image', 'main_image', 7.6, 1.85, 5.43, 2.89),
      slot('image_caption', 'body', 7.6, 4.82, 5.43, 1.57),
    ],
  },
  C: {
    code: 'C',
    name: '二二网格',
    use: '四个并列要点，每点配小图或图标',
    slots: [
      slot('cell_1_image', 'small_image', 0.6, 1.6, 1.6, 1.6),
      slot('cell_1_title', 'title', 2.45, 1.65, 3.85, 0.45),
      slot('cell_1_body', 'body', 2.45, 2.2, 3.85, 1.6),
      slot('cell_2_image', 'small_image', 7.1, 1.6, 1.6, 1.6),
      slot('cell_2_title', 'title', 8.95, 1.65, 3.85, 0.45),
      slot('cell_2_body', 'body', 8.95, 2.2, 3.85, 1.6),
      slot('cell_3_image', 'small_image', 0.6, 4.55, 1.6, 1.6),
      slot('cell_3_title', 'title', 2.45, 4.6, 3.85, 0.45),
      slot('cell_3_body', 'body', 2.45, 5.15, 3.85, 1.6),
      slot('cell_4_image', 'small_image', 7.1, 4.55, 1.6, 1.6),
      slot('cell_4_title', 'title', 8.95, 4.6, 3.85, 0.45),
      slot('cell_4_body', 'body', 8.95, 5.15, 3.85, 1.6),
    ],
  },
  D: {
    code: 'D',
    name: '三栏',
    use: '三个并列主题或三组对比',
    slots: [
      slot('col_1_image', 'small_image', 0.55, 1.7, 3.55, 1.9),
      slot('col_1_title', 'title', 0.55, 3.85, 3.55, 0.45),
      slot('col_1_body', 'body', 0.55, 4.4, 3.55, 2.0),
      slot('col_2_image', 'small_image', 4.89, 1.7, 3.55, 1.9),
      slot('col_2_title', 'title', 4.89, 3.85, 3.55, 0.45),
      slot('col_2_body', 'body', 4.89, 4.4, 3.55, 2.0),
      slot('col_3_image', 'small_image', 9.23, 1.7, 3.55, 1.9),
      slot('col_3_title', 'title', 9.23, 3.85, 3.55, 0.45),
      slot('col_3_body', 'body', 9.23, 4.4, 3.55, 2.0),
    ],
  },
  E: {
    code: 'E',
    name: '上图下文',
    use: '一张大图为主，配两段说明',
    slots: [
      slot('main_image', 'main_image', 0.3, 1.35, 12.73, 3.3),
      slot('para_1_title', 'title', 0.3, 4.9, 6.2, 0.45),
      slot('para_1_body', 'body', 0.3, 5.4, 6.2, 1.5),
      slot('para_2_title', 'title', 6.83, 4.9, 6.2, 0.45),
      slot('para_2_body', 'body', 6.83, 5.4, 6.2, 1.5),
    ],
  },
  F: {
    code: 'F',
    name: '横向步骤时间线',
    use: '流程、阶段推进、四步走',
    slots: [
      slot('step_1_title', 'title', 0.6, 3.5, 3.15, 0.45),
      slot('step_1_body', 'body', 0.6, 4.05, 3.15, 1.4),
      slot('step_2_title', 'title', 3.8, 3.5, 3.15, 0.45),
      slot('step_2_body', 'body', 3.8, 4.05, 3.15, 1.4),
      slot('step_3_title', 'title', 7.0, 3.5, 3.15, 0.45),
      slot('step_3_body', 'body', 7.0, 4.05, 3.15, 1.4),
      slot('step_4_title', 'title', 10.2, 3.5, 3.15, 0.45),
      slot('step_4_body', 'body', 10.2, 4.05, 3.15, 1.4),
      slot('image_strip', 'main_image', 0.3, 5.7, 12.73, 1.15, true),
    ],
  },
  G: {
    code: 'G',
    name: '左1右2分列',
    use: '左侧窄栏放要点/导航，右侧宽栏放主内容（比例 1:2）',
    slots: [
      slot('left_title', 'title', 0.55, 1.6, 3.66, 0.45),
      slot('left_body', 'body', 0.55, 2.15, 3.66, 1.2),
      slot('left_image', 'small_image', 0.55, 3.55, 3.66, 1.9),
      slot('left_note', 'body', 0.55, 5.65, 3.66, 1.0),
      slot('main_image', 'main_image', 4.96, 1.6, 7.82, 2.7),
      slot('right_title', 'title', 4.96, 4.55, 7.82, 0.45),
      slot('right_body', 'body', 4.96, 5.1, 7.82, 1.55),
    ],
  },
  H: {
    code: 'H',
    name: '左右平分、左列分上下',
    use: '左右两大块并列，左块再分上下两段',
    slots: [
      slot('left_top_image', 'small_image', 0.55, 1.6, 2.2, 2.15),
      slot('left_top_title', 'title', 3.0, 1.65, 3.29, 0.45),
      slot('left_top_body', 'body', 3.0, 2.2, 3.29, 1.55),
      slot('left_bottom_title', 'title', 0.55, 4.45, 5.74, 0.45),
      slot('left_bottom_body', 'body', 0.55, 5.0, 5.74, 1.65),
      slot('main_image', 'main_image', 7.04, 1.6, 5.74, 2.9),
      slot('right_title', 'title', 7.04, 4.75, 5.74, 0.45),
      slot('right_body', 'body', 7.04, 5.3, 5.74, 1.35),
    ],
  },
};

export const LAYOUT_CODES = Object.keys(LAYOUTS) as LayoutCode[];

export function isLayoutCode(value: string): value is LayoutCode {
  return (LAYOUT_CODES as readonly string[]).includes(value);
}

/** 某版式的全部槽位：统一页眉 + 该版式的内容槽位。 */
export function allSlots(code: LayoutCode): LayoutSlot[] {
  return [...COMMON_SLOTS, ...LAYOUTS[code].slots];
}

export function findSlot(
  code: LayoutCode,
  slotId: string
): LayoutSlot | undefined {
  return allSlots(code).find((s) => s.id === slotId);
}

// ─── 隐形版式选择（阶段 0 草稿启发式） ──────────────────────────────────────
// 阶段 1 的 outline 确认流程会取代它：那时每页的版式与理由由 outline 定，
// 并以 layoutAssignments 落库。这里只给“现有纯提示词生成”一个确定性的
// 默认选择，让每页都能说出“用了哪个版式、为什么”。
export interface LayoutHints {
  /** 关键数字（KPI）个数 */
  kpiCount?: number;
  /** 步骤个数 */
  stepCount?: number;
  /** 并列要点个数 */
  pointCount?: number;
  /** 是否有一张主图 */
  hasMainImage?: boolean;
  /** 是否有小图/图标 */
  hasSmallImages?: boolean;
  /** 是否左右两大块并列 */
  twoBlocks?: boolean;
}

export function suggestLayout(hints: LayoutHints): {
  layout: LayoutCode;
  reason: string;
} {
  const kpi = hints.kpiCount ?? 0;
  const steps = hints.stepCount ?? 0;
  const points = hints.pointCount ?? 0;
  if (kpi >= 2)
    return {
      layout: 'A',
      reason: `有 ${kpi} 个关键数字，用数据条+四卡一页讲清`,
    };
  if (steps >= 4)
    return { layout: 'F', reason: `${steps} 步流程，用横向步骤时间线展开` };
  if (points === 4 && hints.hasSmallImages)
    return { layout: 'C', reason: '四个并列要点各配小图，用二二网格' };
  if (points === 3 && !hints.hasMainImage)
    return { layout: 'D', reason: '三个并列主题，用三栏对比' };
  if (steps >= 2 && hints.hasMainImage)
    return { layout: 'B', reason: `${steps} 步说明配一张主图，左文右图` };
  if (hints.twoBlocks)
    return { layout: 'H', reason: '左右两大块并列、左列再分上下' };
  if (hints.hasMainImage && points >= 2)
    return { layout: 'G', reason: '主图配侧栏要点，左 1 右 2 分列' };
  if (hints.hasMainImage)
    return { layout: 'E', reason: '一张大图为主，下方两段说明' };
  return { layout: 'B', reason: '默认左文右图：要点在左、主图在右' };
}

// ─── 主题与 Logo 注入（唯一注入点） ─────────────────────────────────────────
// 生成时由 service.ts 追加到 Presenton 请求的 instructions 末尾。
// 色值与 Logo 位置只从本文件的常量取，不得在别处另写一套。
export function buildThemeInstructions(): string {
  const c = PPT_THEME_COLORS;
  return [
    '【主题与版式要求（固定模板，不得更改）】',
    `主题色：标题蓝 ${c.titleBlue}、深海军蓝 ${c.deepNavy}、亮蓝 ${c.brightBlue}、绿 ${c.green}、橙 ${c.orange}、浅蓝 ${c.lightBlue}、分隔灰蓝 ${c.dividerGrayBlue}、卡片底 ${c.cardBg}。`,
    `字体：${PPT_THEME_FONTS.title}；${PPT_THEME_FONTS.subtitle}；${PPT_THEME_FONTS.cardTitle}；${PPT_THEME_FONTS.body}；${PPT_THEME_FONTS.kpiNumber}；${PPT_THEME_FONTS.caption}。`,
    `页面尺寸 ${PPT_SLIDE_SIZE_IN.width}×${PPT_SLIDE_SIZE_IN.height} 英寸。页眉统一：标题在左上（x=0.30in, y=0.05in, 宽 10.50in），副标题在其下，分隔线用分隔灰蓝 ${c.dividerGrayBlue}。`,
    `Logo 已嵌在 sysmex 模板右上角（x=${PPT_LOGO_SLOT.x}in, y=${PPT_LOGO_SLOT.y}in, ${PPT_LOGO_SLOT.width}×${PPT_LOGO_SLOT.height} 英寸），不要另外放 Logo，标题区不得压住 Logo。`,
    '数据条用深海军蓝底、白字；卡片底用卡片底色，卡片顶边按亮蓝/标题蓝/绿/橙循环着色；图片按比例裁切填充，不得拉伸变形。',
    `主题版本 ${PPT_THEME_VERSION}。`,
  ].join('\n');
}

/**
 * 标题页开关的指令块（导航＋意图优化）：与主题块同路，写进 instructions。
 * standard 模式还以 include_title_slide 参数发给 Presenton
 * （generate 请求模型的默认值是 true，不传即保留标题页）；smart 模式
 * 的 /create 接口无此参数，文本是唯一表达。
 */
export function buildTitlePageInstructions(titlePage: boolean): string {
  return titlePage
    ? '【标题页要求】保留标题页：第 1 页是封面（标题＋汇报人＋日期＋概述），之后各页讲内容。'
    : '【标题页要求】不要做封面/标题页：第 1 页就是内容页（标题＋要点），直接讲内容；不要只放标题、汇报人和日期。';
}
