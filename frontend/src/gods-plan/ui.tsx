import type { ButtonHTMLAttributes, HTMLAttributes, Ref } from 'react'
import { GodIcon } from './icons'
import './glass.css'

export interface GlassSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  tone?: 'dark' | 'light'
  ref?: Ref<HTMLDivElement>
}

export interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  ref?: Ref<HTMLButtonElement>
}

export interface GlassIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string
  label: string
  size?: number
  ref?: Ref<HTMLButtonElement>
}

export interface GlassPillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
  ref?: Ref<HTMLSpanElement>
}

function classes(...values: (string | undefined)[]) {
  return values.filter(Boolean).join(' ')
}

export function GlassSurface({ tone = 'dark', className, children, ...props }: GlassSurfaceProps) {
  return (
    <div {...props} className={classes('gp-glass', `gp-glass--${tone}`, className)}>
      {children}
    </div>
  )
}

export function GlassButton({ variant = 'secondary', type = 'button', className, children, ...props }: GlassButtonProps) {
  return (
    <button {...props} type={type} className={classes('gp-button', `gp-button--${variant}`, className)}>
      {children}
    </button>
  )
}

export function GlassIconButton({ icon, label, size = 22, type = 'button', className, children, ...props }: GlassIconButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={classes('gp-button', 'gp-button--ghost', 'gp-icon-button', className)}
      aria-label={props['aria-label'] ?? label}
      title={props.title ?? label}
    >
      <GodIcon name={icon} size={size} />
      {children}
    </button>
  )
}

export function GlassPill({ tone = 'neutral', className, children, ...props }: GlassPillProps) {
  return (
    <span {...props} className={classes('gp-pill', `gp-pill--${tone}`, className)}>
      {children}
    </span>
  )
}
