import { useId, useState } from 'react'
import type { CSSProperties } from 'react'
import './people.css'

export interface AvatarProps {
  name: string
  src?: string
  size?: number
  className?: string
  decorative?: boolean
}

const palettes = [
  ['#91b8c8', '#436681', '#294958'],
  ['#a7b6d5', '#657d9d', '#354963'],
  ['#a5c2b6', '#5e8b90', '#355664'],
  ['#b7b9cf', '#7b839e', '#4b536f'],
]

export function Avatar({ name, src, size = 40, className = '', decorative = false }: AvatarProps) {
  const id = useId().replace(/:/g, '')
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const words = name.trim().split(/\s+/).filter(Boolean)
  const initials = words.length > 1
    ? `${Array.from(words[0])[0]}${Array.from(words[words.length - 1])[0]}`.toLocaleUpperCase()
    : Array.from(words[0] || '—').slice(0, 2).join('').toLocaleUpperCase()
  const seed = Array.from(name).reduce((value, letter) => (value * 31 + (letter.codePointAt(0) ?? 0)) >>> 0, 0)
  const palette = palettes[seed % palettes.length]
  const hasImage = Boolean(src && src !== failedSource)

  return (
    <span
      className={`gp-people-avatar ${className}`.trim()}
      style={{ '--gp-avatar-size': `${size}px` } as CSSProperties}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name || 'Citizen avatar'}
      aria-hidden={decorative || undefined}
      data-fallback={!hasImage || undefined}
    >
      {hasImage ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading={size >= 80 ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onError={() => setFailedSource(src ?? null)}
        />
      ) : (
        <svg viewBox="0 0 96 96" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}-avatar`} x1="9" y1="0" x2="83" y2="96" gradientUnits="userSpaceOnUse">
              <stop stopColor={palette[0]} />
              <stop offset="0.55" stopColor={palette[1]} />
              <stop offset="1" stopColor={palette[2]} />
            </linearGradient>
            <radialGradient id={`${id}-light`} cx="0" cy="0" r="1" gradientTransform="translate(25 14) rotate(64) scale(75 64)" gradientUnits="userSpaceOnUse">
              <stop stopColor="#eff8ff" stopOpacity="0.38" />
              <stop offset="1" stopColor="#eff8ff" stopOpacity="0" />
            </radialGradient>
          </defs>
          <path fill={`url(#${id}-avatar)`} d="M0 0h96v96H0z" />
          <path fill={`url(#${id}-light)`} d="M0 0h96v96H0z" />
          <path d="M-13 82C8 59 30 73 54 63c27-12 32-35 55-25v65H-13Z" fill="#d6e8f3" fillOpacity="0.09" />
          <path d="M-6 88C16 71 37 88 64 73c20-11 26-29 41-28" stroke="#edf6ff" strokeOpacity="0.12" />
          <text x="48" y="51" textAnchor="middle" dominantBaseline="middle" fill="#f5f9fc" fontFamily="inherit" fontSize="32" fontWeight="500" letterSpacing="-1.5">
            {initials}
          </text>
        </svg>
      )}
    </span>
  )
}
