// Browser-only bridge for deterministic screenshots/tests (scripts/shoot.mjs). Not used by the UI.
import { useStore } from './store'
import { cameraTo, leadMap, renderStats } from './world/registry'
import type { CameraMode, CameraPose } from './world/camera'
import { clock } from './world/playback'
import type { WorldScene } from './babylon/scene'
import type { GlobeScene } from './globe/GlobeScene'

declare global {
  interface Window {
    __cityshift?: {
      seek: (t: number) => void
      play: () => void
      pause: () => void
      setSpeed: (s: number) => void
      camera?: (pose: CameraPose, mode?: CameraMode) => void
      map?: () => ReturnType<typeof leadMap>
      stats?: typeof renderStats
      store?: typeof useStore
      babylon?: WorldScene
      globe?: GlobeScene
    }
  }
}

if (typeof window !== 'undefined') {
  window.__cityshift = {
    seek: (t) => clock.seek(t),
    play: () => clock.play(),
    pause: () => clock.pause(),
    setSpeed: (s) => clock.setSpeed(s),
    camera: (pose, mode = 'district') => cameraTo(pose, mode),
    map: () => leadMap(),
    stats: renderStats,
    store: useStore,
  }
}
