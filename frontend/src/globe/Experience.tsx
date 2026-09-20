import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import App from '../App'
import { live } from '../live/session'
import type { LiveSession } from '../live/types'
import { useStore } from '../store'
import { clock } from '../world/playback'
import { cityPose } from '../babylon/camera'
import type { WorldScene } from '../babylon/scene'
import { destinationPack, type Location } from './flight'
import type { GlobePhase } from './Globe'
import './globe.css'

const Globe = lazy(() => import('./Globe'))
type Phase = GlobePhase | 'city'

export default function Experience({ initialCity }: { initialCity: boolean }) {
  const [phase, setPhase] = useState<Phase>(initialCity ? 'city' : 'globe')
  const phaseRef = useRef(phase)
  const [mounted, setMounted] = useState(initialCity)
  const [ready, setReady] = useState(false)
  const [selected, setSelected] = useState<Location | null>(null)
  const [rendererError, setRendererError] = useState<string | null>(null)
  const apiError = useStore((s) => s.error)
  const scene = useRef<WorldScene | null>(null)
  const requestedSession = useRef<string | null>(null)
  const visiblePhase = phase === 'preparing' && ready && selected && !rendererError && !apiError ? 'flight' : phase
  useLayoutEffect(() => { phaseRef.current = visiblePhase }, [visiblePhase])

  const globe = useCallback((push = true) => {
    clock.pause()
    scene.current?.setActive(false)
    requestedSession.current = null
    setSelected(null)
    setPhase('globe')
    phaseRef.current = 'globe'
    if (push && window.location.pathname !== '/') window.history.pushState(null, '', '/')
  }, [])

  useEffect(() => {
    const preload = window.setTimeout(() => setMounted(true), 1800)
    const pop = () => {
      if (window.location.pathname.replace(/\/+$/, '') === '/world') {
        setMounted(true)
        setPhase('city')
        scene.current?.setActive(true)
      } else globe(false)
    }
    window.addEventListener('popstate', pop)
    return () => { window.clearTimeout(preload); window.removeEventListener('popstate', pop) }
  }, [globe])

  const worldReady = useCallback((ws: WorldScene) => {
    scene.current = ws
    if (phaseRef.current !== 'city') ws.camera.apply({ ...cityPose(ws.world), radius: 7200, elevation: 78 })
    ws.scene.executeWhenReady(() => {
      if (ws.scene.isDisposed) return
      setReady(ws.world.pack_id === 'toronto')
      ws.setActive(phaseRef.current !== 'globe')
    })
  }, [])

  const worldError = useCallback((message: string) => {
    setRendererError(message)
    setReady(false)
    scene.current = null
    if (phaseRef.current !== 'city') setMounted(false)
  }, [])

  // A city picked from the Live cities list is continued instead of the pack's most recent one.
  const applyRequestedSession = useCallback(() => {
    const sid = requestedSession.current
    if (!sid || live.session?.session_id === sid) return
    requestedSession.current = null
    void live.open(sid).then(() => live.play())
  }, [])

  const select = useCallback((place: Location, session?: LiveSession) => {
    if (phaseRef.current !== 'globe') return
    phaseRef.current = 'preparing'
    clock.pause()
    setRendererError(null)
    useStore.getState().setError(null)
    requestedSession.current = session?.session_id ?? null
    setSelected(place)
    setPhase('preparing')
    setMounted(true)
    const packId = destinationPack(place)
    if (scene.current?.world.pack_id === packId && !scene.current.scene.isDisposed) {
      scene.current.setActive(true)
      scene.current.camera.apply({ ...cityPose(scene.current.world), radius: 7200, elevation: 78 })
    } else setReady(false)
    const store = useStore.getState()
    // a failed first load (backend not up yet) is retried on every click rather than sticking until a reload
    if (!store.pack) void store.boot(packId).then(applyRequestedSession)
    else if (store.pack.pack_id !== packId) void store.selectPack(packId).then(applyRequestedSession)
    else applyRequestedSession()
  }, [applyRequestedSession])

  const reveal = useCallback(() => {
    applyRequestedSession()
    const ws = scene.current
    if (!ws || ws.scene.isDisposed) return
    ws.setActive(true)
    const pose = cityPose(ws.world)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) ws.camera.apply(pose)
    else ws.camera.flyTo(pose, 2700, 'city')
  }, [applyRequestedSession])

  const complete = useCallback(() => {
    applyRequestedSession()
    setPhase('city')
    phaseRef.current = 'city'
    if (window.location.pathname !== '/world') window.history.pushState(null, '', '/world')
  }, [applyRequestedSession])

  return (
    <>
      {mounted && <div className="city-experience" aria-hidden={phase !== 'city'} inert={phase !== 'city'} style={{ opacity: visiblePhase === 'city' || visiblePhase === 'flight' ? 1 : 0 }}>
        <App active={phase === 'city'} onGlobe={() => globe()} onWorldReady={worldReady} onWorldError={worldError} />
      </div>}
      {visiblePhase !== 'city' && <Suspense fallback={<div className="orbital-boot">Concrete Consequences <span>Loading globe…</span></div>}>
        <Globe phase={visiblePhase} selected={selected} error={rendererError ?? apiError} onSelect={select} onReveal={reveal} onComplete={complete} onCancel={() => globe(false)} />
      </Suspense>}
    </>
  )
}
