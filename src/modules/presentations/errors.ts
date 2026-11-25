// Presenton 错误类型 —— 阶段 1 从 service.ts 抽出，供 sources.ts /
// images.ts 共用，避免 service ↔ sources 的循环 import。service.ts
// 重新导出，保持原有 import 路径可用。

export type PresentonErrorCode =
  | 'not_configured'
  | 'invalid_input'
  | 'llm_quota_exceeded'
  | 'generation_timeout'
  | 'presenton_error';

export class PresentonError extends Error {
  constructor(
    public code: PresentonErrorCode,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}
