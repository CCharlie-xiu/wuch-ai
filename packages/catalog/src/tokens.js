// ─────────────────────────────────────────────────────────────────────────────
// 设计 token：组件参数里的 space / style / maxWidth / 文字颜色字号粗细都从这里取值
// ─────────────────────────────────────────────────────────────────────────────

export const TOKENS = {
  // 4px 间距刻度：padding=3 → 12px
  space: [0, 4, 8, 12, 16, 20, 24, 32, 40, 48],
  radius: { none: 0, sm: 4, md: 8, lg: 12, xl: 16, pill: 999 },
  text: {
    small: { size: 12, weight: 400 },
    'small-heavy': { size: 12, weight: 600 },
    default: { size: 14, weight: 400 },
    'default-heavy': { size: 14, weight: 600 },
    large: { size: 17, weight: 400 },
    'large-heavy': { size: 17, weight: 600 },
    xl: { size: 22, weight: 500 },
    'xl-heavy': { size: 22, weight: 700 },
    code: { size: 13, weight: 400, mono: true },
  },
  // 文字的颜色 / 字号 / 粗细：只给语义名，不收任意色值，跟随主题
  textColor: {
    default: 'var(--text)',
    muted: 'var(--muted)',
    primary: 'var(--accent)',
    success: '#15803d',
    warning: '#b45309',
    danger: '#b91c1c',
    info: '#1d4ed8',
  },
  textSize: { xs: 12, sm: 13, md: 14, lg: 17, xl: 20, '2xl': 24, '3xl': 30 },
  textWeight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  gap: { none: 0, s: 8, m: 12, l: 16, xl: 24 },
  maxWidth: { full: '100%', '2xl': '672px', '3xl': '768px', '4xl': '896px', '5xl': '1024px' },
};

export const TEXT_STYLES = Object.keys(TOKENS.text);
export const TEXT_COLORS = Object.keys(TOKENS.textColor);
export const TEXT_SIZES = Object.keys(TOKENS.textSize);
export const TEXT_WEIGHTS = Object.keys(TOKENS.textWeight);
export const SPACE_TOKENS = Object.keys(TOKENS.gap);
export const MAX_WIDTHS = Object.keys(TOKENS.maxWidth);
export const VARIANTS = ['card', 'sunk', 'clear', 'outline', 'ghost', 'primary', 'secondary', 'tertiary', 'success', 'warning', 'danger', 'neutral', 'info'];
