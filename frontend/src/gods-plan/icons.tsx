import { useId } from 'react'
import type { ReactNode } from 'react'

export interface GodIconProps {
  name: string
  size?: number
  className?: string
  strokeWidth?: number
}

export interface EventGlyphProps {
  kind: string
  size?: number
  className?: string
}

const people = (
  <>
    <circle cx="8.6" cy="7" r="3" />
    <path d="M2.5 20v-1.6a6.1 6.1 0 0 1 12.2 0V20M16.4 4.4a2.9 2.9 0 0 1 0 5.7M17 13.3a5 5 0 0 1 4.5 5V20" />
  </>
)

const pin = (
  <>
    <path d="M18.6 9.3c0 5-6.6 11.4-6.6 11.4S5.4 14.3 5.4 9.3a6.6 6.6 0 1 1 13.2 0Z" />
    <circle cx="12" cy="9.2" r="2.2" />
  </>
)

const bolt = <path d="m13.5 2-9 12h7l-1 8 9-12h-7l1-8Z" />

const sparkles = (
  <path d="M9.6 2c.8 5.5 2.8 7.5 8.3 8.3-5.5.8-7.5 2.8-8.3 8.3-.8-5.5-2.8-7.5-8.3-8.3C6.8 9.5 8.8 7.5 9.6 2Zm10.1-.5c.3 2.3 1.2 3.2 3.5 3.5-2.3.3-3.2 1.2-3.5 3.5-.3-2.3-1.2-3.2-3.5-3.5 2.3-.3 3.2-1.2 3.5-3.5ZM19 14c.4 2.8 1.5 3.9 4.3 4.3-2.8.4-3.9 1.5-4.3 4.3-.4-2.8-1.5-3.9-4.3-4.3 2.8-.4 3.9-1.5 4.3-4.3Z" fill="currentColor" stroke="none" />
)

const more = (
  <g fill="currentColor" stroke="none">
    <circle cx="5" cy="12" r="1.35" />
    <circle cx="12" cy="12" r="1.35" />
    <circle cx="19" cy="12" r="1.35" />
  </g>
)

const iconShapes: Record<string, ReactNode> = {
  globe: (
    <g transform="rotate(-12 12 12)">
      <circle cx="12" cy="12" r="10" />
      <ellipse cx="12" cy="12" rx="4.5" ry="10" />
      <path d="M2.6 8.5c6.1 1.9 12.7 1.9 18.8 0M2.6 15.5c6.1 1.9 12.7 1.9 18.8 0" />
    </g>
  ),
  cursor: <path d="M5 2.6v17.3l4.7-4.6 3.1 6.1 3-1.5-3.2-6.2H20L5 2.6Z" fill="currentColor" stroke="none" />,
  map: <path d="m3 4 6-2 6 2 6-2v18l-6 2-6-2-6 2V4Zm6-2v18m6-16v18" />,
  people,
  users: people,
  bus: (
    <>
      <path d="m5 3.5-1.5 9V19h17v-6.5l-1.5-9H5ZM3.5 12.5h17M2 9.5v4m20-4v4M6 19v2m12-2v2" />
      <path d="M7 15.8h1m8 0h1" strokeWidth="2.6" />
    </>
  ),
  warning: (
    <>
      <path d="m10.7 3.4-9 16a1.5 1.5 0 0 0 1.3 2.2h18a1.5 1.5 0 0 0 1.3-2.2l-9-16a1.5 1.5 0 0 0-2.6 0Z" />
      <path d="M12 8.6v5.6" />
      <circle cx="12" cy="17.7" r=".95" fill="currentColor" stroke="none" />
    </>
  ),
  cloud: <path d="M6.5 19a4.5 4.5 0 0 1-.7-8.9 6.4 6.4 0 0 1 12.4-1.6 5.3 5.3 0 0 1-.1 10.5H6.5Z" />,
  layers: (
    <>
      <path d="m12 2-10 5 10 5 10-5-10-5Z" fill="currentColor" stroke="none" />
      <path d="m2.5 12 9.5 4.8 9.5-4.8m-19 5.2L12 22l9.5-4.8" />
    </>
  ),
  sparkles,
  'arrow-right': <path d="M4 12h15m-6-6 6 6-6 6" />,
  'arrow-left': <path d="M20 12H5m6-6-6 6 6 6" />,
  navigation: <path d="m21.7 2.3-6.9 19.1a.7.7 0 0 1-1.3 0l-3.4-7.5-7.5-3.4a.7.7 0 0 1 0-1.3l19.1-6.9Z" fill="currentColor" stroke="none" />,
  settings: (
    <>
      <path d="m9.6 3 .6-1h3.6l.6 1 .5 2 1.6.9 2-.5 1.1.1 1.8 3.1-.4 1-1.5 1.5v1.8l1.5 1.5.4 1-1.8 3.1-1.1.1-2-.5-1.6.9-.5 2-.6 1h-3.6l-.6-1-.5-2-1.6-.9-2 .5-1.1-.1-1.8-3.1.4-1 1.5-1.5v-1.8L3.1 9.6l-.4-1 1.8-3.1 1.1-.1 2 .5 1.6-.9.4-2Z" />
      <circle cx="12" cy="11.9" r="3.2" />
    </>
  ),
  plus: <path d="M12 4v16M4 12h16" />,
  minus: <path d="M4 12h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  'chevron-left': <path d="m15 5-7 7 7 7" />,
  'chevron-down': <path d="m5 9 7 7 7-7" />,
  'chevron-up': <path d="m5 15 7-7 7 7" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.4 15.4 5 5" /></>,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  shield: <><path d="m12 2 8 3v6.6c0 4.4-3.4 7.6-8 10.4-4.6-2.8-8-6-8-10.4V5l8-3Z" /><path d="m8.1 11.8 2.6 2.6 5.2-5.2" /></>,
  wind: <path d="M3 7h11.4a2.8 2.8 0 1 0-2.8-2.8M2 11.5h17a3 3 0 1 0-3-3M4 16h9.4a2.8 2.8 0 1 1-2.8 2.8" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
      <path d="M12 1v2m0 18v2M1 12h2m18 0h2M4.2 4.2l1.5 1.5m12.6 12.6 1.5 1.5M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5" />
    </>
  ),
  thermometer: <><path d="M9 14.1V5a3 3 0 0 1 6 0v9.1a5 5 0 1 1-6 0ZM12 8v9" /><circle cx="12" cy="18" r="1.7" fill="currentColor" stroke="none" /><path d="M18 5h2m-2 4h2" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M7 2v6m10-6v6M3 10h18M7 14h2m4 0h4M7 17h2m4 0h2" /></>,
  clock: <><circle cx="12" cy="12" r="9.5" /><path d="M12 6v6l4 2.5" /></>,
  person: <><circle cx="12" cy="7" r="3.8" /><path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2" /></>,
  briefcase: <><rect x="2.5" y="7" width="19" height="14" rx="2.4" /><path d="M8 7V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V7M2.5 12a23 23 0 0 0 19 0M12 11.5v4" /></>,
  home: <path d="m2 11 10-8.5L22 11M5 9v12h5v-7h4v7h5V9" />,
  heart: <path d="M20.2 5.1a5.3 5.3 0 0 0-7.5 0l-.7.7-.7-.7a5.3 5.3 0 0 0-7.5 7.5L12 21l8.2-8.4a5.3 5.3 0 0 0 0-7.5Z" />,
  activity: <path d="M2 12h4l3-8 5 16 3-8h5" />,
  route: <><circle cx="5" cy="5" r="2.5" /><circle cx="19" cy="19" r="2.5" /><path d="M10 5h6.5a3.5 3.5 0 0 1 0 7h-9a3.5 3.5 0 0 0 0 7H14" /></>,
  building: <><path d="M7 21V3h12v18M3 21V10h4M2 21h20M10.5 7h1m3 0h1m-5 4h1m3 0h1m-5 4h1m3 0h1M11 21v-3h4v3" /></>,
  chart: <><path d="M3 3v18h18M7 16v-4m5 4V8m5 8V4" /><path d="M7 16v-4m5 4V8m5 8V4" strokeWidth="2.6" /></>,
  play: <path d="m8 4 12 8-12 8V4Z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /></>,
  stop: <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" />,
  expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6" />,
  brain: (
    <>
      <path d="M12 5a3 3 0 0 0-5.8-1.1 3.6 3.6 0 0 0-3 5.2 4 4 0 0 0 .4 7.2A3.6 3.6 0 0 0 7 20.5 2.7 2.7 0 0 0 12 19V5Zm0 0a3 3 0 0 1 5.8-1.1 3.6 3.6 0 0 1 3 5.2 4 4 0 0 1-.4 7.2 3.6 3.6 0 0 1-3.4 4.2A2.7 2.7 0 0 1 12 19M6.2 3.9V7m11.6-3.1V7M3.6 16.3H6m14.4 0H18M8 10a3 3 0 0 1 4 2m4-2a3 3 0 0 0-4 2" />
    </>
  ),
  message: <><path d="M21 11.5c0 4.7-4 8.5-9 8.5a10 10 0 0 1-3.5-.6L3 21l1.4-4.9A7.9 7.9 0 0 1 3 11.5C3 6.8 7 3 12 3s9 3.8 9 8.5Z" /><path d="M7.5 11.5h.1m4.4 0h.1m4.4 0h.1" strokeWidth="2.5" /></>,
  target: <><circle cx="12" cy="12" r="9.5" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  send: <path d="m21 3-7 18-3.5-7.5L3 10l18-7Zm0 0L10.5 13.5" />,
  star: <path d="m12 2.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.4-5.8-3-5.8 3L7.3 14 2.6 9.4l6.5-.9L12 2.6Z" />,
  rotate: <><path d="M20.3 8A8.6 8.6 0 1 0 21 15M21 3v5.5h-5.5" /></>,
  info: <><circle cx="12" cy="12" r="9.5" /><path d="M12 11v6m-1.5 0h3" /><circle cx="12" cy="7" r="1" fill="currentColor" stroke="none" /></>,
  filter: <path d="M3 4h18l-7 8v7l-4 2v-9L3 4Z" />,
  link: <><path d="m10 6 2-2a5.7 5.7 0 0 1 8 8l-2 2M14 18l-2 2a5.7 5.7 0 0 1-8-8l2-2m2.5 5.5 7-7" /></>,
  pin,
  location: pin,
  'map-pin': pin,
  locate: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 1v4m0 14v4M1 12h4m14 0h4" /></>,
  radius: <><circle cx="12" cy="12" r="9" strokeDasharray="2.5 3" /><path d="M12 12h8m-3-3 3 3-3 3" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /></>,
  more,
  'more-horizontal': more,
  leaf: <><path d="M21 3C11 2 3 5 3 12.5a6.5 6.5 0 0 0 6.5 6.5C17 19 21 11 21 3Z" /><path d="M2 22 16 8M7 17v-5m0 5h5" /></>,
  bolt,
  lightning: bolt,
  outage: bolt,
  tornado: <path d="M22 3H6C.5 3 .5 7 6 7h12c4 0 4 3 0 3H8c-3 0-3 3 0 3h7c3 0 3 3 0 3h-4c-2 0-2 2 0 3l2 1-3 3" />,
  flood: <path d="M2 7c2.5-3 4.5 3 7 0s4.5 3 7 0 4.5 3 6 0M2 13c2.5-3 4.5 3 7 0s4.5 3 7 0 4.5 3 6 0M2 19c2.5-3 4.5 3 7 0s4.5 3 7 0 4.5 3 6 0" />,
  wildfire: <path d="M12 2c1 5-5 6-5 10-1-1-1.5-2-1.5-3C.5 15 5 22 12 22s11.5-7 6.5-13c0 3-2 4-2 4C18 8 15 4 12 2Zm0 11c0 3-3 3.5-3 6a3 3 0 0 0 6 0c0-2-1.5-4-3-6Z" />,
  clipboard: <><rect x="5" y="4" width="14" height="18" rx="2" /><rect x="8.5" y="2" width="7" height="4" rx="1.3" /><path d="M9 11h6m-6 4h6m-6 4h3" /></>,
  document: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 12h8m-8 4h8m-8 4h4" /></>,
}

export function GodIcon({ name, size = 24, className, strokeWidth = 1.8 }: GodIconProps) {
  return (
    <svg
      className={['gp-icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {Object.hasOwn(iconShapes, name) ? iconShapes[name] : iconShapes.info}
    </svg>
  )
}

type EventPalette = readonly [string, string, string]

const eventPalettes: Record<string, EventPalette> = {
  tornado: ['#d2dce5', '#8799ac', '#4d6278'],
  earthquake: ['#f98c82', '#d75c60', '#a64251'],
  flood: ['#87e3fa', '#41afd9', '#2481b8'],
  wildfire: ['#ffcd65', '#ff9b41', '#e75b3f'],
  outage: ['#ffe494', '#ffc152', '#e59b2f'],
  riot: ['#b1a5db', '#8679ba', '#62538e'],
  transit: ['#85c9ed', '#519ac8', '#386eaa'],
  custom: ['#bcd8ff', '#9297e2', '#7661b1'],
  orbital: ['#d7c3ff', '#a487e4', '#6658ba'],
  normal: ['#ffed9a', '#ffd56c', '#efb64f'],
}

function eventArtwork(kind: string, paint: string, light: string, shade: string): ReactNode {
  switch (kind) {
    case 'tornado':
      return (
        <>
          <ellipse cx="24" cy="42" rx="9" ry="1.7" fill="#3b536f" opacity=".12" />
          <path d="M8 12c1 6 9 8 8 12-1 3 7 5 6 9 0 3-3 5-3 7 8-4 7-9 11-13 3-3 1-6 5-9l4-6H8Z" fill={paint} />
          <path d="M18 23c5 2 11 1 14-1-1 3-7 4-12 3m3 5c3 0 5-1 6-2-1 3-3 5-7 6" fill="none" stroke={shade} strokeWidth="2.3" opacity=".47" />
          <path d="M11 17c7 2.5 16 3 24-.2M17 23c4 1.7 10 2 14 .6M21 29c2 .8 4 .7 6 .1" fill="none" stroke={light} strokeWidth="1.8" strokeLinecap="round" opacity=".9" />
          <path d="M6 9c3-5 13-6 23-5 8 .6 13 3 13 6 0 4-10 7-21 6C11 15.3 4 12.7 6 9Z" fill={paint} />
          <path d="M9 9c7-3 19-3.3 28-.5M7.5 12c8.5 3.2 24.5 3.1 32.5-1" fill="none" stroke={light} strokeWidth="2" strokeLinecap="round" opacity=".9" />
          <path d="M17 7.8c4-1 10-1 14 0" fill="none" stroke="#f3f8fc" strokeWidth="1.3" strokeLinecap="round" opacity=".8" />
        </>
      )
    case 'earthquake':
      return (
        <>
          <ellipse cx="24" cy="41" rx="15" ry="2" fill="#73586c" opacity=".12" />
          <path d="M24 12C18 3 5 6 5 16c0 9 13 17 19 22 6-5 19-13 19-22C43 6 30 3 24 12Z" fill={paint} />
          <path d="M24 12 21 19l6 4-6 6 3 9" fill="none" stroke="#8b364a" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" opacity=".7" />
          <path d="M6 22h8l3-6 4 13 4-10 3 6h14" fill="none" stroke="#ffe1d8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 15c1-5 7-7 11-3" fill="none" stroke={light} strokeWidth="2.3" strokeLinecap="round" opacity=".8" />
        </>
      )
    case 'flood':
      return (
        <>
          <ellipse cx="24" cy="41" rx="17" ry="2.4" fill="#3c88ae" opacity=".13" />
          <path d="M4 18c4-7 9-7 13-1 3 5 7 5 11-1 4-6 10-5 16 1v10H4V18Z" fill={paint} />
          <path d="M3 26c5-5 10-5 14-1 4 5 8 5 12 0s10-5 16 1v9c-8 4-16 3-23 4-7 0-13-1-19-4v-9Z" fill={paint} />
          <path d="M5 19c4-4 7-4 11 0s8 4 12-1 9-4 14 0M4 29c4-4 8-4 12 0s9 4 13-1 9-3 14 0" fill="none" stroke="#cdf5ff" strokeWidth="2.4" strokeLinecap="round" opacity=".93" />
          <path d="M7 36c4-2 8-1 11 1s8 2 12 0 8-2 11-1" fill="none" stroke={light} strokeWidth="1.7" strokeLinecap="round" opacity=".75" />
        </>
      )
    case 'wildfire':
      return (
        <>
          <ellipse cx="24" cy="42" rx="12.5" ry="2" fill="#a6633d" opacity=".13" />
          <path d="M25 3c3 9-5 11-5 18-4-2-4-6-4-9C6 21 5 31 12 38c6 6 18 6 25-1 9-10 2-21-3-26 1 7-3 10-3 10 2-8-2-15-6-18Z" fill={paint} />
          <path d="M25 20c1 6-5 8-5 12-3-1-3-3-3-5-5 5-2 15 7 15 9 0 14-9 8-16 0 4-3 5-3 5 1-5-2-9-4-11Z" fill="#ffde87" />
          <path d="M25 30c0 3-5 5-4 8 .4 2 1.6 3 3.8 3 4 0 5.3-5 .2-11Z" fill="#fff4c0" />
          <path d="M13 23c-3 7-1 12 2 14" fill="none" stroke={light} strokeWidth="1.8" strokeLinecap="round" opacity=".75" />
          <path d="M39 5c1 2 1 4-.5 5-1.5-1-1.5-3 .5-5Z" fill="#ffce73" />
        </>
      )
    case 'outage':
      return (
        <>
          <ellipse cx="24" cy="42" rx="10" ry="1.7" fill="#ac813c" opacity=".12" />
          <path d="M27 3 9 27h13l-2 17 20-26H27l3-15h-3Z" fill={paint} stroke="#d69835" strokeWidth=".65" strokeLinejoin="round" />
          <path d="M27 6 12 25h12l-2 12" fill="none" stroke="#fff0b7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity=".9" />
          <path d="m8 7 2 4m27-4-2 4M5 18h4m29 13h4" fill="none" stroke="#dfad58" strokeWidth="1.5" strokeLinecap="round" opacity=".55" />
        </>
      )
    case 'riot':
      return (
        <>
          <ellipse cx="24" cy="41" rx="18" ry="2.2" fill="#665881" opacity=".11" />
          <circle cx="11" cy="15" r="5.8" fill={paint} />
          <path d="M1.5 33v-4a9.5 9.5 0 0 1 19 0v4a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2Z" fill={paint} />
          <circle cx="37" cy="15" r="5.8" fill={paint} />
          <path d="M27.5 33v-4a9.5 9.5 0 0 1 19 0v4a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2Z" fill={paint} />
          <path d="M8 13c1-2 3-3 5-2m21 2c1-2 3-3 5-2" fill="none" stroke={light} strokeWidth="1.8" strokeLinecap="round" />
          <path d="M12 37v-5a12 12 0 0 1 24 0v5a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3Z" fill={paint} stroke="#e2ddf4" strokeWidth=".8" />
          <circle cx="24" cy="12.5" r="7" fill={paint} stroke="#e2ddf4" strokeWidth=".8" />
          <path d="M20 10.5c1-2 4-3 6-1.8M16 30c1-3 3-4.5 5-5" fill="none" stroke={light} strokeWidth="1.8" strokeLinecap="round" opacity=".9" />
        </>
      )
    case 'transit':
      return (
        <>
          <ellipse cx="24" cy="43" rx="15" ry="2" fill="#476786" opacity=".13" />
          <path d="m15 36-3 7m21-7 3 7M14 40h20" fill="none" stroke="#6987a6" strokeWidth="2" strokeLinecap="round" />
          <rect x="9" y="5" width="30" height="33" rx="7" fill={paint} stroke="#457fae" strokeWidth=".6" />
          <rect x="14" y="10" width="20" height="13" rx="2.8" fill="#e3f4ff" />
          <path d="M24 10v13" fill="none" stroke="#74acd2" strokeWidth="1.3" />
          <path d="m15 11 13 1-13 8v-9Z" fill="#fff" opacity=".58" />
          <path d="M19 7.4h10" fill="none" stroke="#e3f5ff" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="15" cy="29.5" r="2.4" fill="#f4f8e4" />
          <circle cx="33" cy="29.5" r="2.4" fill="#f4f8e4" />
          <path d="M20 29h8m-8 3h8M15 35h18" fill="none" stroke="#c4e5f7" strokeWidth="1.4" strokeLinecap="round" opacity=".87" />
        </>
      )
    case 'normal':
      return (
        <>
          <circle cx="24" cy="23" r="10" fill={paint} />
          <path d="M24 4v5m0 28v5M5 23h5m28 0h5M10.5 9.5l3.5 3.5m20 20 3.5 3.5m-27 0L14 33m20-20 3.5-3.5" fill="none" stroke="#eec35c" strokeWidth="2.5" strokeLinecap="round" />
          <path d="M19 18c2-3 6-3 9-1" fill="none" stroke="#fff6c7" strokeWidth="2.1" strokeLinecap="round" />
        </>
      )
    case 'orbital':
      return (
        <>
          <path d="M24 25 39 4m-9 25L45 8M19 18 33 3" fill="none" stroke={light} strokeWidth="3" strokeLinecap="round" />
          <path d="M12 40c-7-4-8-12-3-18 5-5 11-6 17-2l11-8-5 16c-1 10-12 17-20 12Z" fill={paint} />
          <circle cx="17" cy="29" r="8" fill={paint} stroke="#e7d9ff" strokeWidth="1.2" />
          <circle cx="15" cy="26" r="2.2" fill={shade} opacity=".5" />
          <circle cx="20" cy="31" r="2.7" fill={shade} opacity=".35" />
          <path d="m38 30 1.5 3.5L43 35l-3.5 1.5L38 40l-1.5-3.5L33 35l3.5-1.5L38 30Z" fill={light} />
        </>
      )
    default:
      return (
        <>
          <ellipse cx="24" cy="42" rx="13" ry="1.8" fill="#6d6c97" opacity=".1" />
          <path d="M21 6c1.5 11 5.5 15 16.5 16.5C26.5 24 22.5 28 21 39c-1.5-11-5.5-15-16.5-16.5C15.5 21 19.5 17 21 6Z" fill={paint} />
          <path d="M38 2c.5 5 2.5 7 7.5 7.5C40.5 10 38.5 12 38 17c-.5-5-2.5-7-7.5-7.5C35.5 9 37.5 7 38 2Z" fill={paint} />
          <path d="M38 28c.4 4 1.8 5.6 6 6-4.2.4-5.6 2-6 6-.4-4-1.8-5.6-6-6 4.2-.4 5.6-2 6-6Z" fill={paint} />
          <path d="M20 13c-1.3 5-3.5 7.2-8.5 8.5" fill="none" stroke="#edf2ff" strokeWidth="1.8" strokeLinecap="round" opacity=".9" />
        </>
      )
  }
}

export function EventGlyph({ kind, size = 40, className }: EventGlyphProps) {
  const id = useId()
  const normalized = kind.toLowerCase().replace(/[\s_]+/g, '-')
  const aliases: Record<string, string> = { 'power-outage': 'outage', 'civil-unrest': 'riot', 'transit-disruption': 'transit', fire: 'wildfire', flooding: 'flood' }
  const eventKind = Object.hasOwn(aliases, normalized) ? aliases[normalized] : normalized
  const palette = Object.hasOwn(eventPalettes, eventKind) ? eventPalettes[eventKind] : eventPalettes.custom
  const paint = `url(#${id}-paint)`

  return (
    <svg
      className={['gp-event-glyph', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-event-kind={eventKind}
    >
      <defs>
        <linearGradient id={`${id}-paint`} x1="12" y1="5" x2="35" y2="43" gradientUnits="userSpaceOnUse">
          <stop stopColor={palette[0]} />
          <stop offset=".48" stopColor={palette[1]} />
          <stop offset="1" stopColor={palette[2]} />
        </linearGradient>
      </defs>
      {eventArtwork(eventKind, paint, palette[0], palette[2])}
    </svg>
  )
}
