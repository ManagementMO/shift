const paths = {
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  close: 'M6 6l12 12M18 6L6 18',
  swarm: 'M12 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4M5 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4M19 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4M12 7v5M5 17v-5h14v5',
  ai: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4M10 10h4v4h-4z',
  database: 'M4 6a8 3 0 1 0 16 0 8 3 0 1 0-16 0M4 6v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0',
  display: 'M3 4h18v13H3zM12 17v4M7 21h10',
  chevron: 'M7 10l5 5 5-5',
  message: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2zM7 9h10M7 13h6',
} as const

export default function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

export function BrandMark({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 28 28" fill="currentColor" aria-hidden="true"><path d="M3 3h10v4H7v14h6v4H3V3zm12 0h10v4h-6v14h6v4H15V3z" /></svg>
}
