// GENERATED FILE - DO NOT EDIT. Source: src/theme/tokens.json; regenerate with `npm run gen:tokens`.

/**
 * Raw colour values for native props that need a string rather than a className
 * (status bar, ActivityIndicator, TextInput placeholders, react-native-svg fills, the
 * navigation theme): the fixed palette colours, and each theme's Stacks semantic tokens.
 * Read the current theme's with `useThemeColors()` (@/theme/use-theme-colors). The same
 * values back the Tailwind classes (src/global.css).
 */
export const colors = {
  black: '#000000',
  white: '#ffffff',
  light: {
    background: '#f5f7fa', // --color-background
    foreground: '#121c36', // --color-foreground
    card: '#ffffff', // --color-card
    cardForeground: '#121c36', // --color-card-foreground
    popover: '#ffffff', // --color-popover
    popoverForeground: '#121c36', // --color-popover-foreground
    primary: '#15203d', // --color-primary
    primaryForeground: '#f5f7fa', // --color-primary-foreground
    secondary: '#eaedf3', // --color-secondary
    secondaryForeground: '#18244a', // --color-secondary-foreground
    muted: '#eef1f5', // --color-muted
    mutedForeground: '#5b6680', // --color-muted-foreground
    subtleForeground: '#8590a6', // --color-subtle-foreground
    accent: '#e8ecf3', // --color-accent
    accentForeground: '#121c36', // --color-accent-foreground
    destructive: '#c42b3c', // --color-destructive
    destructiveSoft: '#fde8ea', // --color-destructive-soft
    border: '#e0e5ed', // --color-border
    borderStrong: '#cdd4df', // --color-border-strong
    input: '#d4dae4', // --color-input
    ring: '#db2777', // --color-ring
    brand: '#db2777', // --color-brand
    brandForeground: '#ffffff', // --color-brand-foreground
    brandSoft: '#fce7f1', // --color-brand-soft
    brandInk: '#a3195a', // --color-brand-ink
    success: '#0d7f5a', // --color-success
    successSoft: '#e1f5ec', // --color-success-soft
    warning: '#a86206', // --color-warning
    warningSoft: '#fdf1dc', // --color-warning-soft
    info: '#2c56c9', // --color-info
    infoSoft: '#e6edfd', // --color-info-soft
    community: '#6a3fd4', // --color-community
    communitySoft: '#efe9fd', // --color-community-soft
    chart1: '#db2777', // --color-chart-1
    chart2: '#3b5bdb', // --color-chart-2
    chart3: '#0d9488', // --color-chart-3
    chart4: '#d97706', // --color-chart-4
    chart5: '#7c3aed', // --color-chart-5
    seq0: '#e9edf3', // --color-seq-0
    seq1: '#fbd5e6', // --color-seq-1
    seq2: '#f5a3c7', // --color-seq-2
    seq3: '#e8649f', // --color-seq-3
    seq4: '#cc2b78', // --color-seq-4
    seq5: '#8f1550', // --color-seq-5
    shelfEdge: '#d9dfe8', // --color-shelf-edge
    shelfShadow: 'rgba(18, 28, 54, 0.16)', // --color-shelf-shadow
    topbar: 'rgba(245, 247, 250, 0.84)', // --color-topbar
    glass: 'rgba(255, 255, 255, 0.72)', // --color-glass
    glassBorder: 'rgba(18, 28, 54, 0.08)', // --color-glass-border
    overlay: 'rgba(14, 20, 38, 0.38)', // --color-overlay
  },
  dark: {
    background: '#0a0f1e', // --color-background
    foreground: '#e7ebf4', // --color-foreground
    card: '#10172b', // --color-card
    cardForeground: '#e7ebf4', // --color-card-foreground
    popover: '#131b31', // --color-popover
    popoverForeground: '#e7ebf4', // --color-popover-foreground
    primary: '#eef1f8', // --color-primary
    primaryForeground: '#0a0f1e', // --color-primary-foreground
    secondary: '#1a2340', // --color-secondary
    secondaryForeground: '#dfe5f2', // --color-secondary-foreground
    muted: '#151d34', // --color-muted
    mutedForeground: '#8f9ab3', // --color-muted-foreground
    subtleForeground: '#66718b', // --color-subtle-foreground
    accent: '#1a2340', // --color-accent
    accentForeground: '#e7ebf4', // --color-accent-foreground
    destructive: '#f0606e', // --color-destructive
    destructiveSoft: '#3a1720', // --color-destructive-soft
    border: '#1d2640', // --color-border
    borderStrong: '#2a3555', // --color-border-strong
    input: '#283252', // --color-input
    ring: '#ec4f95', // --color-ring
    brand: '#ec4f95', // --color-brand
    brandForeground: '#ffffff', // --color-brand-foreground
    brandSoft: '#3a1530', // --color-brand-soft
    brandInk: '#f78bbb', // --color-brand-ink
    success: '#3cc994', // --color-success
    successSoft: '#0f2e26', // --color-success-soft
    warning: '#f0b04d', // --color-warning
    warningSoft: '#33260f', // --color-warning-soft
    info: '#7d9bf2', // --color-info
    infoSoft: '#17234a', // --color-info-soft
    community: '#b59cff', // --color-community
    communitySoft: '#251b45', // --color-community-soft
    chart1: '#e4458b', // --color-chart-1
    chart2: '#6680ec', // --color-chart-2
    chart3: '#17a093', // --color-chart-3
    chart4: '#cc7f16', // --color-chart-4
    chart5: '#8f72f2', // --color-chart-5
    seq0: '#161e36', // --color-seq-0
    seq1: '#3a1a37', // --color-seq-1
    seq2: '#6b1f4f', // --color-seq-2
    seq3: '#a12a6a', // --color-seq-3
    seq4: '#d9418a', // --color-seq-4
    seq5: '#f58bbb', // --color-seq-5
    shelfEdge: '#1f2944', // --color-shelf-edge
    shelfShadow: 'rgba(0, 0, 0, 0.5)', // --color-shelf-shadow
    topbar: 'rgba(10, 15, 30, 0.8)', // --color-topbar
    glass: 'rgba(22, 30, 54, 0.7)', // --color-glass
    glassBorder: 'rgba(255, 255, 255, 0.07)', // --color-glass-border
    overlay: 'rgba(3, 6, 14, 0.62)', // --color-overlay
  },
} as const;

/** One theme's semantic colours (`colors.light` / `colors.dark`). */
export type ThemeColors = { readonly [K in keyof typeof colors.light]: string };
