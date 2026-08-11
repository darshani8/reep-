'use client';

import { createTheme } from '@mui/material/styles';

// Teaches createTheme about the MuiDataGrid slot below.
import type {} from '@mui/x-data-grid/themeAugmentation';

import { LinkBehaviour } from '@/components/link-behaviour';

/**
 * The REEP design system.
 *
 * Three decisions drive everything here.
 *
 * **One hue, and only variations of it.** This product tells a nineteen-year-old
 * they are falling behind. A field of saturated chrome turns that into alarm.
 * So the whole interface is one warm hue at 36° — ink, paper, accent, status
 * and every chart series are that hue at different lightness and saturation.
 * There is no white in the light scheme at all: the page is cream and every
 * surface is the same cream lifted or deepened.
 * Nothing on screen is a colour for its own sake, and because nothing competes,
 * the single saturated step reads as emphasis wherever it appears.
 *
 * What that costs, stated plainly: hue can no longer tell "on track" from "at
 * risk", so the icon and the word beside every status are not decoration — they
 * are the whole signal. See STATUS below.
 *
 * **Space separates, not lines.** Borders and shadows are ink that carries no
 * information. Cards are surfaces without outlines; sections are set apart by
 * whitespace and the occasional hairline. This is what makes a dense dashboard
 * feel calm without removing anything from it.
 *
 * **Inter, and a narrow weight range.** Humanist proportions and a tall
 * x-height read as plain-spoken rather than corporate, and stay legible at the
 * 12–13px an information-dense screen needs. Weights stop at 600: 700+ reads as
 * raised voice, and in a screen full of numbers the *size* already establishes
 * hierarchy. Large text gets negative tracking (optical correction — type set
 * large looks loose at default spacing); body text keeps generous 1.6 leading,
 * which measurably reduces reading effort on long rows.
 *
 * The chart palette is validated, not chosen by eye — see CHART_SERIES below.
 */

/**
 * One hue, and everything is a variation of it.
 *
 * The hue is warm — 36°, the hue of paper rather than of screen. There is no
 * white anywhere in the light scheme: the page is cream and every surface is
 * that same cream at a different lightness. Ink, accent, status and all four
 * chart series are the same 36° at different saturation and lightness, so the
 * product has exactly one colour and a great many variations of it.
 *
 * **Cream is what makes the neumorphism work**, not a coat of paint over it. An
 * extruded tile has to be cut from the same material as the page — on white
 * there is nowhere lighter for the top-left highlight to go, so the effect
 * collapses into a grey smudge. A mid-toned cream leaves room in both
 * directions, which is why the two surface tones below are ordered the way they
 * are: the page is the *deeper* one and paper the lighter, because a tile rises
 * out of the page and cannot be darker than it.
 *
 * The cost of one hue is that **lightness does all the work hue used to**, so
 * every value here is measured rather than picked. Moving off near-white spent
 * about a fifth of the available contrast range, so the chart ramp below was
 * re-solved rather than re-tinted.
 */
export const HUE = 36;

/**
 * The two tones of the one cream. Everything else in the light scheme is
 * derived from these, and nothing in it is `#ffffff`.
 */
export const CREAM = {
  /// The page. The deeper of the two, so tiles have somewhere to rise to.
  page: '#efe9dd',
  /// Raised surfaces — cards, menus, the glass fallback.
  paper: '#f8f4ec',
} as const;

/// The single accent — the most saturated step of the one hue.
export const ACCENT = {
  light: '#8a5a1e',
  dark: '#d9a85f',
} as const;

/**
 * Four categorical slots, one hue, placed by solving rather than by eye.
 *
 * Categorical data normally separates by hue, and a monochrome scheme gives
 * that up — so the slots have to separate by luminance instead, and two
 * constraints fight each other:
 *
 *  - every slot must clear **3:1 against its own surface**, or a bar vanishes;
 *  - adjacent slots must stay **~1.6:1 from each other**, or two series in a
 *    legend become indistinguishable.
 *
 * Four rungs is what the available luminance range fits. A fifth would have to
 * break one of the two, which is why `RankedBarChart` keeps its direct labels
 * and every chart keeps a legend — with one hue, the label is doing more work
 * than it used to.
 *
 *   light: 10.71 / 7.12 / 4.63 / 3.06 against #efe9dd
 *   dark:   3.09 / 5.00 / 8.05 / 13.09 against #14120d
 *
 * Light separations are 1.50–1.54:1 — tighter than the 1.62:1 the near-white
 * page afforded, because cream costs range at the top end. Re-measure both rows
 * after any change; the outermost rung in each has no headroom left.
 */
export const CHART_SERIES_LIGHT = ['#3a301f', '#62471f', '#8b5f1c', '#b5781d'] as const;
export const CHART_SERIES_DARK = ['#7c5d2e', '#ab7b32', '#d4a155', '#ead5b6'] as const;

/**
 * Status, in the same hue as everything else.
 *
 * This is the change with teeth. Green/amber/red carried "on track" and "at
 * risk" at a glance, and lightness alone cannot replace that — so the rule the
 * system already had becomes load-bearing rather than a nicety: **status always
 * ships an icon and a word**, and `StatusChip` enforces it. What the colour now
 * does is rank severity — critical is the darkest, most saturated step and
 * still draws the eye first — rather than name it.
 *
 * `serious` is gone; it was never used and was indistinguishable from `warning`
 * even when the two had different hues.
 */
export const STATUS = {
  good: '#8b5f1c',
  warning: '#62471f',
  critical: '#3a301f',
} as const;

/**
 * The same status, as text on a chip filled with 8% of itself.
 *
 * A separate token because a colour's contrast is a property of the pair, not
 * of the colour — and `STATUS` was solved against the *page*. A filled chip
 * lays a tint of its own hue underneath the label, which darkens the backdrop
 * from `#efe9dd` to `#e7dece` and drops the lightest step from 4.63:1 to
 * 4.19:1. Measuring against the page and then rendering on the tint is how a
 * palette passes its own audit and fails a real one.
 *
 * Only the lightest step needed moving; `warning` and `critical` clear 6.3:1
 * and 9.3:1 on their own tints untouched. Thinning the tint instead was tried
 * and does not reach: even at 4% the pair is 4.41:1, so the ink had to move.
 *
 *   light  good on #e7dece: 4.61:1   (and 5.09:1 on the bare page)
 *   dark   good on #292216: 4.60:1   (and 5.47:1 on the bare page)
 *
 * Dark needs it too, which was not obvious and was nearly missed: on the page
 * the dark tint barely lifts a near-black surface, but these chips mostly sit
 * on a *raised* surface, where the tint composites to `#292216` and takes
 * `success.main` down to 4.20:1. The lesson is the same one twice — solve
 * against the backdrop the thing renders on, not the one it is nominally "on".
 */
export const STATUS_ON_TINT = {
  light: {
    good: '#83591b',
    warning: STATUS.warning,
    critical: STATUS.critical,
    /// `secondary.main` fails the same way on the same tint (4.40:1).
    accent: '#83591b',
  },
  dark: {
    good: '#b7802e',
    warning: '#d4a155',
    critical: '#ead5b6',
    accent: ACCENT.dark,
  },
} as const;

const FONT_STACK = 'var(--font-inter), system-ui, -apple-system, "Segoe UI", sans-serif';

export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'data-theme' },

  colorSchemes: {
    light: {
      palette: {
        mode: 'light',
        // "primary" is ink, not a brand colour — buttons and emphasis default to
        // near-black, and the accent is reserved for the one action that matters.
        // Ink and neutrals carry the same 36° cast rather than being grey — a
        // warm accent on true grey reads as stuck on, and warm ink on a cream
        // page reads as printed rather than as a screenshot of a white one.
        primary: { main: '#1c1810', light: '#443c2d', dark: '#100d08', contrastText: CREAM.paper },
        secondary: { main: ACCENT.light, light: '#a8752f', dark: '#6b4413', contrastText: CREAM.paper },
        success: { main: STATUS.good, dark: STATUS.good },
        warning: { main: STATUS.warning, dark: STATUS.warning },
        error: { main: STATUS.critical, dark: STATUS.critical },
        info: { main: ACCENT.light },
        background: { default: CREAM.page, paper: CREAM.paper },
        // `disabled` names a role, not a state: it is the colour of hints,
        // captions and the TechNote — real prose at 12px. At the old #9a9aa4
        // that prose was 2.69:1 on the page, well under the 4.5:1 body-text
        // floor, and worse on a neumorphic tile. It is not used for disabled
        // controls anywhere, so there is nothing here that WCAG exempts.
        text: { primary: '#1c1810', secondary: '#5a5142', disabled: '#6d6353' },
        divider: 'rgba(28,24,16,0.12)',
        action: { hover: 'rgba(28,24,16,0.04)', selected: 'rgba(138,90,30,0.10)' },
      },
    },
    dark: {
      palette: {
        mode: 'dark',
        primary: { main: '#f5f1e8', light: '#fffdf7', dark: '#cdc6b6', contrastText: '#14120d' },
        secondary: { main: ACCENT.dark, light: '#e8c48c', dark: '#ab7b32', contrastText: '#14120d' },
        // `dark` is set explicitly here because MUI derives it as
        // `darken(main, 0.3)` otherwise — and `TONE_INK` in kit.tsx uses the
        // `.dark` step for status *text*. On a dark background that derivation
        // runs the wrong way: error text landed at 3.09:1 and warning at
        // 4.11:1, both under the floor, on exactly the "at risk" wording this
        // product exists to communicate. Pinning them to `main` keeps that text
        // at 5.7:1 while the fills stay unchanged.
        // Same hue, ranked by lightness: the lighter the step, the louder. On a
        // dark surface that inverts the light scheme, so `critical` is the
        // brightest here and the darkest there — in both cases the one that
        // pulls the eye first.
        success: { main: '#ab7b32', dark: '#ab7b32' },
        warning: { main: '#d4a155', dark: '#d4a155' },
        error: { main: '#ead5b6', dark: '#ead5b6' },
        info: { main: ACCENT.dark },
        background: { default: '#14120d', paper: '#1e1a14' },
        text: { primary: '#f5f1e8', secondary: '#b0a894', disabled: '#968d79' },
        divider: 'rgba(245,241,232,0.12)',
        action: { hover: 'rgba(245,241,232,0.05)', selected: 'rgba(217,168,95,0.15)' },
      },
    },
  },

  // Small radii. Heavily rounded corners read as playful; this is a record
  // system people are assessed against.
  shape: { borderRadius: 8 },

  typography: {
    fontFamily: FONT_STACK,
    h1: { fontSize: '1.625rem', fontWeight: 600, letterSpacing: '-0.021em', lineHeight: 1.25 },
    h2: { fontSize: '1.3125rem', fontWeight: 600, letterSpacing: '-0.017em', lineHeight: 1.3 },
    h3: { fontSize: '1.0625rem', fontWeight: 600, letterSpacing: '-0.011em', lineHeight: 1.4 },
    h4: { fontSize: '0.9375rem', fontWeight: 600, letterSpacing: '-0.006em' },
    subtitle1: { fontSize: '0.9375rem', fontWeight: 500 },
    subtitle2: { fontSize: '0.8125rem', fontWeight: 500 },
    body1: { fontSize: '0.9375rem', lineHeight: 1.6 },
    body2: { fontSize: '0.8125rem', lineHeight: 1.6 },
    caption: { fontSize: '0.75rem', lineHeight: 1.5 },
    button: { textTransform: 'none', fontWeight: 500, letterSpacing: 0 },
  },

  /**
   * Inside a `styleOverrides` callback, always `t.vars.palette.*` — never
   * `t.palette.*`, and never `t.palette.mode`.
   *
   * A `styleOverrides` callback is run once, against the default scheme, and
   * its result is emitted as a single static class. `t.palette.text.secondary`
   * therefore resolves to the *light* hex and stays that colour in dark mode:
   * the grid headers rendered #5a5142 on #1e1a14 (2.21:1, against a 4.5:1
   * floor) and every cell hairline drew rgba(28,24,16,0.12) — near-black lines
   * on a near-black surface, so the grid lost its rules entirely. `t.vars`
   * emits `var(--mui-palette-…)` instead, which is what `colorSchemeSelector`
   * above swaps when `data-theme` flips.
   *
   * The same trap applies to `t.palette.mode`: it is always `'light'` here, so
   * a mode ternary silently keeps its light branch in both schemes. Use
   * `t.applyStyles('dark', {…})`, which emits a real `[data-theme="dark"]`
   * rule.
   */
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        // Columns of numbers must align; a large standalone figure must not, or
        // it looks gappy at display size.
        '.tabular': { fontVariantNumeric: 'tabular-nums' },
        body: { WebkitFontSmoothing: 'antialiased' },

        /**
         * One focus ring, everywhere.
         *
         * There was none. `disableElevation` on MuiButton (below) is
         * implemented by zeroing `boxShadow` — including the
         * `&.Mui-focusVisible` shadow MUI uses as its focus indicator — so
         * every primary action on all seventeen screens was keyboard-focusable
         * with nothing to show for it. The ripple is not an indicator: it
         * fires on click, fades, and never appears for Tab.
         *
         * The ratio matters as much as the presence: `action.hover` is 1.06:1
         * against the page, so an outline drawn in it would be invisible. This
         * uses the accent, which the grid already focuses cells with at 6.07:1.
         */
        '*:focus-visible': {
          outline: '2px solid var(--mui-palette-secondary-main)',
          outlineOffset: '2px',
          // Some MUI surfaces clip their own overflow; without this the ring
          // is drawn underneath the neighbouring element.
          zIndex: 1,
        },
        // Only suppress it where a component draws a better one of its own —
        // the DataGrid cell ring below is inset by design.
        '.MuiDataGrid-cell:focus, .MuiDataGrid-cell:focus-within': { outline: 'none' },

        /// Reachable by Tab, invisible until then.
        '.skip-link': {
          position: 'absolute',
          left: -9999,
          top: 0,
          zIndex: 1400,
          padding: '10px 16px',
          borderRadius: 8,
          fontSize: '0.875rem',
          fontWeight: 500,
          textDecoration: 'none',
          backgroundColor: 'var(--mui-palette-background-paper)',
          color: 'var(--mui-palette-text-primary)',
          border: '1px solid var(--mui-palette-divider)',
          '&:focus': { left: 8, top: 8 },
        },

        // --- surface tokens -------------------------------------------------
        // Declared as custom properties rather than as `sx` callbacks because
        // every consumer is a Server Component, and a function cannot cross that
        // boundary. Both schemes are defined here and nowhere else, so a surface
        // can never be styled for light and forgotten in dark.
        //
        // The selector matches `colorSchemeSelector` above deliberately: these
        // switch on exactly the same attribute MUI's own palette variables do.
        //
        // Every value below is the cream at a different lightness. Nothing here
        // is white or grey: a highlight drawn in `#ffffff` on a cream page does
        // not read as light falling on the tile, it reads as a hole in it —
        // which is the single most common way neumorphism on a tinted surface
        // goes wrong. The highlights are the same 36° hue lifted, the shadows
        // are the same hue deepened, and the tile gradient straddles the page
        // so it looks extruded from the material it sits on.
        ':root': {
          '--reep-glass-bg': 'rgba(252,249,242,0.58)',
          '--reep-glass-solid': '#faf7f0',
          '--reep-glass-border': 'rgba(255,252,245,0.75)',
          '--reep-glass-shadow': '0 10px 34px rgba(58,48,31,0.10)',
          '--reep-glass-highlight': 'inset 0 1px 0 rgba(255,253,247,0.9)',

          // The gradient's two ends are both surfaces text sits on, so both are
          // measured, not just the flat colour: the deeper end holds the 12px
          // hint colour at 4.62:1. That is what limits how far the tile can be
          // extruded — the shadows below carry the rest of the depth, which they
          // can do without touching legibility.
          '--reep-neu-bg': 'linear-gradient(145deg, #faf7f0, #eae3d4)',
          '--reep-neu-flat': CREAM.page,
          '--reep-neu-shadow':
            '7px 7px 16px rgba(58,48,31,0.13), -7px -7px 16px rgba(255,252,244,0.92)',
          '--reep-neu-shadow-lift':
            '10px 10px 22px rgba(58,48,31,0.16), -10px -10px 22px rgba(255,253,247,1)',
          '--reep-neu-inset':
            'inset 2px 2px 5px rgba(58,48,31,0.16), inset -2px -2px 5px rgba(255,252,244,0.9)',

          // Something has to sit behind glass or there is nothing to refract.
          // Strong enough to be seen through a frosted panel, and confined to
          // the top of the page by the mask on `.reep-ambient` — the dense body
          // text further down reads on the plain background, untinted.
          '--reep-bloom-a': 'rgba(176,124,44,0.20)',
          '--reep-bloom-b': 'rgba(138,90,30,0.14)',
          '--reep-bloom-c': 'rgba(212,161,85,0.11)',

          // An editable grid cell — the page cream pressed into the lighter
          // card, so a field reads as a recess rather than as empty space.
          // Status-chip ink, re-solved against the chip's own 8% tint.
          '--reep-chip-good': STATUS_ON_TINT.light.good,
          '--reep-chip-accent': STATUS_ON_TINT.light.accent,

          '--reep-cell-well': '#f1ece1',
          '--reep-cell-well-hover': '#ece5d7',
          '--reep-cell-well-inset':
            'inset 1px 1px 2px rgba(58,48,31,0.07), inset -1px -1px 2px rgba(255,252,244,0.7)',
        },
        '[data-theme="dark"]': {
          '--reep-glass-bg': 'rgba(36,31,24,0.60)',
          '--reep-glass-solid': '#221e17',
          '--reep-glass-border': 'rgba(245,241,232,0.09)',
          '--reep-glass-shadow': '0 10px 34px rgba(0,0,0,0.48)',
          '--reep-glass-highlight': 'inset 0 1px 0 rgba(245,241,232,0.07)',

          '--reep-neu-bg': 'linear-gradient(145deg, #241f18, #100e09)',
          '--reep-neu-flat': '#1e1a14',
          '--reep-neu-shadow':
            '7px 7px 16px rgba(0,0,0,0.55), -7px -7px 16px rgba(245,241,232,0.03)',
          '--reep-neu-shadow-lift':
            '10px 10px 22px rgba(0,0,0,0.65), -10px -10px 22px rgba(245,241,232,0.042)',
          '--reep-neu-inset':
            'inset 2px 2px 5px rgba(0,0,0,0.6), inset -2px -2px 5px rgba(245,241,232,0.038)',

          '--reep-bloom-a': 'rgba(171,123,50,0.26)',
          '--reep-bloom-b': 'rgba(124,93,46,0.20)',
          '--reep-bloom-c': 'rgba(212,161,85,0.10)',

          // Dark never had the tint problem — the palette tokens already clear
          // the floor (good is 4.60:1 on its own tint), so these are the tokens.
          '--reep-chip-good': STATUS_ON_TINT.dark.good,
          '--reep-chip-accent': STATUS_ON_TINT.dark.accent,

          '--reep-cell-well': '#191510',
          '--reep-cell-well-hover': '#221d15',
          '--reep-cell-well-inset':
            'inset 1px 1px 2px rgba(0,0,0,0.5), inset -1px -1px 2px rgba(245,241,232,0.03)',
        },

        // Translucency is a preference, not a requirement. Where the browser
        // cannot blur, or the reader has asked it not to, the same panel falls
        // back to an opaque surface rather than to unreadable low-contrast text.
        '@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))': {
          '.reep-glass': { background: 'var(--reep-glass-solid) !important' },
        },
        '@media (prefers-reduced-transparency: reduce)': {
          '.reep-glass': {
            background: 'var(--reep-glass-solid) !important',
            backdropFilter: 'none !important',
            WebkitBackdropFilter: 'none !important',
          },
          '.reep-ambient': { display: 'none' },
        },
        // Depth is a screen effect. On paper it is a grey smear over a figure
        // somebody has to read, so every surface flattens for print.
        '@media print': {
          '.no-print': { display: 'none !important' },
          body: { background: '#fff' },
          '.reep-ambient': { display: 'none !important' },
          '.reep-glass, .reep-neu': {
            background: '#fff !important',
            backdropFilter: 'none !important',
            WebkitBackdropFilter: 'none !important',
            boxShadow: 'none !important',
            border: '1px solid #e3e3e0 !important',
          },
        },
      },
    },

    MuiButtonBase: { defaultProps: { LinkComponent: LinkBehaviour } },
    MuiLink: {
      defaultProps: { component: LinkBehaviour, underline: 'hover' },
      styleOverrides: { root: { color: 'inherit', textDecorationColor: 'currentColor' } },
    },

    // Surfaces carry no outline and no shadow. Against the deeper cream of the
    // page, the lighter cream of a card is enough to read as a distinct plane.
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { backgroundImage: 'none' } },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { backgroundImage: 'none', border: 'none' } },
    },
    MuiCardContent: {
      styleOverrides: { root: { padding: 0, '&:last-child': { paddingBottom: 0 } } },
    },

    /**
     * `subtitle1` and `subtitle2` are type scales, not document structure.
     *
     * MUI maps both to `<h6>` by default, which quietly turned a great deal of
     * ordinary content into headings: a student's name in the header bar, the
     * value under every `Fact` ("1h 40m"), the first line of a two-line grid
     * cell. Screen-reader users navigate by heading, and a page whose heading
     * list is a dozen h6 stat values is harder to move around than one with no
     * headings at all. It also failed `heading-order` outright — the page goes
     * h1, then h6, with nothing in between.
     *
     * Neutral elements here; anything that is genuinely a heading asks for one
     * with `component="h2"`, the way `SectionCard` does.
     */
    MuiTypography: {
      defaultProps: { variantMapping: { subtitle1: 'div', subtitle2: 'div' } },
    },

    MuiButton: {
      defaultProps: { disableElevation: true, color: 'primary' },
      styleOverrides: {
        root: { borderRadius: 7, paddingInline: 16, minHeight: 38 },
        sizeSmall: { minHeight: 32, paddingInline: 12, fontSize: '0.8125rem' },
        outlined: ({ theme: t }) => ({ borderColor: t.vars.palette.divider }),
        text: { paddingInline: 10 },
      },
    },

    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 500, borderRadius: 6 },
        sizeSmall: { height: 22, fontSize: '0.75rem' },
        outlined: ({ theme: t }) => ({ borderColor: t.vars.palette.divider }),
      },
    },

    // MUI's unselected toggle label is `action.active`, which lands at 4.39:1
    // on the cream page — under the floor for 13px text by a hair, and these
    // are filter controls whose unselected options have to stay readable or the
    // group only tells you what you have already picked. `text.secondary` is
    // 6.46:1 on the page and 7.12:1 on paper; the selected pill sits on
    // `action.selected` and takes full ink at 12.87:1.
    MuiToggleButton: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          textTransform: 'none',
          fontWeight: 500,
          color: t.vars.palette.text.secondary,
          borderColor: t.vars.palette.divider,
          '&.Mui-selected': { color: t.vars.palette.text.primary, fontWeight: 600 },
        }),
      },
    },

    // Thin meters. A 4px bar reads as a measurement; a 10px bar reads as decoration.
    MuiLinearProgress: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          height: 4,
          borderRadius: 2,
          backgroundColor: 'rgba(58,48,31,0.10)',
          ...t.applyStyles('dark', { backgroundColor: 'rgba(245,241,232,0.09)' }),
        }),
        bar: { borderRadius: 2 },
      },
    },

    MuiTextField: { defaultProps: { size: 'small' } },
    MuiOutlinedInput: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 7,
          '& fieldset': { borderColor: t.vars.palette.divider },
        }),
      },
    },

    MuiTooltip: {
      styleOverrides: {
        tooltip: ({ theme: t }) => ({
          backgroundColor: '#1c1810',
          ...t.applyStyles('dark', { backgroundColor: '#332c22' }),
          fontSize: '0.75rem',
          fontWeight: 400,
          padding: '6px 9px',
          borderRadius: 6,
        }),
      },
    },

    MuiTabs: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          minHeight: 40,
          borderBottom: `1px solid ${t.vars.palette.divider}`,
        }),
        indicator: ({ theme: t }) => ({ height: 2, backgroundColor: t.vars.palette.text.primary }),
      },
    },
    MuiTab: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          textTransform: 'none',
          fontWeight: 500,
          fontSize: '0.875rem',
          minHeight: 40,
          padding: '8px 2px',
          marginRight: 24,
          minWidth: 0,
          color: t.vars.palette.text.secondary,
          '&.Mui-selected': { color: t.vars.palette.text.primary, fontWeight: 600 },
        }),
      },
    },

    MuiAlert: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 8,
          border: `1px solid ${t.vars.palette.divider}`,
          alignItems: 'center',
          fontSize: '0.875rem',
        }),
        standard: ({ theme: t }) => ({ backgroundColor: t.vars.palette.action.hover }),
      },
    },

    MuiListItemButton: {
      styleOverrides: {
        root: { borderRadius: 7, paddingTop: 7, paddingBottom: 7 },
      },
    },

    MuiDivider: {
      styleOverrides: { root: ({ theme: t }) => ({ borderColor: t.vars.palette.divider }) },
    },

    // Columns are ruled here too, for the same reason as the grid: these tables
    // are dense rows of numbers, and a figure with no column boundary beside it
    // is a figure you have to count across the header to identify. The first
    // column is spared — the table's own edge already bounds it.
    MuiTableCell: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderBottomColor: t.vars.palette.divider,
          fontSize: '0.8125rem',
          '&:not(:first-of-type)': { borderLeft: `1px solid ${t.vars.palette.divider}` },
        }),
        head: ({ theme: t }) => ({
          fontWeight: 500,
          fontSize: '0.75rem',
          color: t.vars.palette.text.secondary,
          backgroundColor: 'transparent',
        }),
      },
    },

    /**
     * The grid reads as a grid.
     *
     * It used to draw row hairlines only — the reasoning being that whitespace
     * separates and a vertical rule is ink carrying no information. That is
     * true of a read-only table and **false of an editable one**: with nothing
     * between the columns, an empty cell is indistinguishable from the gap
     * beside it, so a student looking at the Time Log cannot see that there is
     * anything there to click, let alone where one field ends and the next
     * begins. The rule is the boundary of a control, which is information.
     *
     * It stays a hairline at `divider`, not a border — enough to bound a field,
     * not enough to draw a cage around every number.
     */
    MuiDataGrid: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          border: 'none',
          fontSize: '0.8125rem',
          '--DataGrid-rowBorderColor': t.vars.palette.divider,
          '& .MuiDataGrid-columnHeaders': { backgroundColor: 'transparent' },
          '& .MuiDataGrid-columnHeader': { paddingInline: 8 },
          '& .MuiDataGrid-columnHeaderTitle': {
            fontWeight: 500,
            fontSize: '0.75rem',
            color: t.vars.palette.text.secondary,
          },
          '& .MuiDataGrid-cell': {
            borderBottom: `1px solid ${t.vars.palette.divider}`,
            paddingInline: 8,
            display: 'flex',
            alignItems: 'center',
          },
          // Drawn as a *left* border on every column but the first, not a right
          // border on every column but the last. Same lines, but `:last-of-type`
          // is not the last visible column — the grid appends a scrollbar filler
          // after it, so a trailing rule would land in the margin and read as an
          // empty extra column.
          '& .MuiDataGrid-cell:not(:first-of-type), & .MuiDataGrid-columnHeader:not(:first-of-type)':
            {
              borderLeft: `1px solid ${t.vars.palette.divider}`,
            },

          /**
           * An editable cell is a field, and looks like one.
           *
           * `cell-editable` is applied by the column, not inferred — the grid
           * exposes no class for `editable`, and guessing from the header name
           * would break the first time a read-only column was called "Note".
           *
           * The well is the *page* colour showing through the lighter card: on
           * a cream system an input is pressed into the surface rather than
           * raised out of it, so this is the neumorphic inset the panels
           * already use, at cell scale.
           */
          '& .MuiDataGrid-cell.cell-editable': {
            backgroundColor: 'var(--reep-cell-well)',
            boxShadow: 'var(--reep-cell-well-inset)',
            cursor: 'text',
          },
          '& .MuiDataGrid-cell.cell-editable:hover': {
            backgroundColor: 'var(--reep-cell-well-hover)',
          },
          // While the editor is open the well is filled in, so the input is not
          // reading through an inset shadow the whole time it is being typed in.
          '& .MuiDataGrid-cell.cell-editable.MuiDataGrid-cell--editing': {
            backgroundColor: t.vars.palette.background.paper,
            boxShadow: 'none',
          },

          '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': {
            outline: `2px solid ${t.vars.palette.secondary.main}`,
            outlineOffset: '-2px',
          },
          '& .MuiDataGrid-columnSeparator': { display: 'none' },
          '& .MuiDataGrid-row:hover': { backgroundColor: t.vars.palette.action.hover },
          '& .MuiDataGrid-footerContainer': {
            borderTop: `1px solid ${t.vars.palette.divider}`,
            minHeight: 46,
          },
          '& .MuiDataGrid-overlay': { backgroundColor: 'transparent' },
          '& .MuiDataGrid-columnHeaders, & .MuiDataGrid-columnHeaderRow': {
            borderBottom: `1px solid ${t.vars.palette.divider}`,
          },
        }),
      },
    },
  },
});

export default theme;
