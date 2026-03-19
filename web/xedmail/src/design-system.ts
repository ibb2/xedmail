// June Design System — Atelier Mail
// Design tokens extracted from the June/Stitch design spec

export const colors = {
  primary: "#6366F1",
  primaryDark: "#4F46E5",
  primaryLight: "#EEF2FF",
  surface: "#FDFCFE",
  surfaceContainer: "#F5F3FF",
  surfaceContainerLow: "#F9F8FF",
  surfaceContainerHigh: "#E9E7F5",
  onSurface: "#1E1B4B",
  onSurfaceVariant: "#4338CA",
  outlineVariant: "#E0E7FF",
  error: "#EF4444",
} as const;

export const fonts = {
  headline: "'Noto Serif', 'Playfair Display', Georgia, serif",
  ui: "'Plus Jakarta Sans', system-ui, sans-serif",
  body: "'Inter', system-ui, sans-serif",
} as const;

export const radius = {
  default: "1rem",
  lg: "2rem",
  xl: "2.5rem",
  full: "9999px",
} as const;

export const shadows = {
  card: "0 0 0 1px rgba(99,102,241,0.05), 0 10px 15px -3px rgba(0,0,0,0.04), 0 40px 60px -15px rgba(0,0,0,0.08)",
} as const;
