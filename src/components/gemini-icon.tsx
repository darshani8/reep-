import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon';

/**
 * The Gemini "spark" — a four-point star in Google's blue→purple→pink gradient.
 *
 * Marks the assistant as Gemini-powered. It is a self-contained inline SVG (no
 * network asset, so it works offline and inside the strict CSP), and it renders
 * as an MUI icon: it takes `fontSize`/`sx` and sits in a `Fab` or nav item
 * exactly like the icon it replaces. The path fill is the gradient rather than
 * `currentColor`, so the brand colours hold regardless of the surface behind it.
 *
 * The gradient id is fixed; when several instances mount, every `url(#…)`
 * resolves to the first (identical) definition, which renders correctly.
 */
export function GeminiIcon(props: SvgIconProps) {
  return (
    <SvgIcon viewBox="0 0 24 24" {...props}>
      <defs>
        <linearGradient
          id="reep-gemini-spark"
          x1="2"
          y1="4"
          x2="22"
          y2="20"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#1BA1E3" />
          <stop offset="0.5" stopColor="#7B5AD9" />
          <stop offset="1" stopColor="#D96570" />
        </linearGradient>
      </defs>
      <path
        fill="url(#reep-gemini-spark)"
        d="M12 0C12 6.6 6.6 12 0 12C6.6 12 12 17.4 12 24C12 17.4 17.4 12 24 12C17.4 12 12 6.6 12 0Z"
      />
    </SvgIcon>
  );
}
