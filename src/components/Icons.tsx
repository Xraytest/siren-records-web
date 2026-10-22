import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Base({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconPlay = (p: IconProps) => (
  <Base {...p} fill="currentColor" stroke="none">
    <path d="M7 4.5 19 12 7 19.5z" />
  </Base>
)

export const IconPause = (p: IconProps) => (
  <Base {...p} fill="currentColor" stroke="none">
    <rect x="6.5" y="4.5" width="4" height="15" />
    <rect x="13.5" y="4.5" width="4" height="15" />
  </Base>
)

export const IconNext = (p: IconProps) => (
  <Base {...p} fill="currentColor" stroke="none">
    <path d="M5 4.5 16 12 5 19.5z" />
    <rect x="17" y="4.5" width="2.4" height="15" />
  </Base>
)

export const IconPrev = (p: IconProps) => (
  <Base {...p} fill="currentColor" stroke="none">
    <path d="M19 4.5 8 12l11 7.5z" />
    <rect x="4.6" y="4.5" width="2.4" height="15" />
  </Base>
)

export const IconShuffle = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 7h3.5l10 10H21M3 17h3.5l3-3M21 7h-4.5l-2.5 2.5" />
    <path d="m18 4 3 3-3 3M18 14l3 3-3 3" />
  </Base>
)

export const IconRepeat = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 9V7h14M18 5l2 2-2 2M20 15v2H6M6 19l-2-2 2-2" />
  </Base>
)

export const IconRepeatOne = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 9V7h14M18 5l2 2-2 2M20 15v2H6M6 19l-2-2 2-2" />
    <path d="M11.4 10.6 13 9.5V15" />
  </Base>
)

export const IconVolume = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 9.5h3L12 5v14l-5-4.5H4z" />
    <path d="M16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />
  </Base>
)

export const IconMute = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 9.5h3L12 5v14l-5-4.5H4z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </Base>
)

export const IconPlus = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 4v16M4 12h16" />
  </Base>
)

export const IconSearch = (p: IconProps) => (
  <Base {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 5 5" />
  </Base>
)

export const IconClose = (p: IconProps) => (
  <Base {...p}>
    <path d="m5 5 14 14M19 5 5 19" />
  </Base>
)

export const IconEdit = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 20h4l11-11-4-4L4 16z" />
    <path d="m14 5 4 4" />
  </Base>
)

export const IconTrash = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    <path d="M10 11v6M14 11v6" />
  </Base>
)

export const IconShare = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3v12M12 3 8 7M12 3l4 4" />
    <path d="M5 12v8h14v-8" />
  </Base>
)

export const IconDownload = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3v12M12 15l-4-4M12 15l4-4" />
    <path d="M5 18v3h14v-3" />
  </Base>
)

export const IconUpload = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 15V3M12 3 8 7M12 3l4 4" />
    <path d="M5 18v3h14v-3" />
  </Base>
)

export const IconGlobe = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.6 3 2.6 14 0 17M12 3.5c-2.6 3-2.6 14 0 17" />
  </Base>
)

export const IconCheck = (p: IconProps) => (
  <Base {...p}>
    <path d="m4 12.5 5 5L20 6" />
  </Base>
)

export const IconArrow = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 12h15M14 7l5 5-5 5" />
  </Base>
)

export const IconUp = (p: IconProps) => (
  <Base {...p}>
    <path d="m6 14 6-6 6 6" />
  </Base>
)

export const IconDown = (p: IconProps) => (
  <Base {...p}>
    <path d="m6 10 6 6 6-6" />
  </Base>
)

export const IconQueue = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 6h11M4 12h11M4 18h7" />
    <path d="M17 10v8l4-2.5" />
  </Base>
)

export const IconLyrics = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 5h16v11H9l-5 4z" />
    <path d="M8 9h8M8 12h5" />
  </Base>
)

export const IconUser = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
  </Base>
)

export const IconLogout = (p: IconProps) => (
  <Base {...p}>
    <path d="M10 4H4v16h6" />
    <path d="M14 8l4 4-4 4M18 12H9" />
  </Base>
)

export const IconGrid = (p: IconProps) => (
  <Base {...p}>
    <rect x="4" y="4" width="7" height="7" />
    <rect x="13" y="4" width="7" height="7" />
    <rect x="4" y="13" width="7" height="7" />
    <rect x="13" y="13" width="7" height="7" />
  </Base>
)

export const IconDisc = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="2" />
  </Base>
)

export const IconLogo = (p: IconProps) => (
  <Base {...p} strokeWidth="1.2">
    <path d="M3 20 12 3l9 17z" />
    <path d="M7 20h10M9 15h6" />
    <path d="M12 3v17" />
  </Base>
)
