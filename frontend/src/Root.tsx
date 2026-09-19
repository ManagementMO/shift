import { lazy, Suspense } from 'react'

import App from './App.tsx'

// `/world` is the Babylon.js living-city route (progressive migration); `/` stays the Mapbox/deck.gl shell.
const WorldApp = lazy(() => import('./babylon/WorldApp.tsx'))

export default function Root() {
  const isWorld = window.location.pathname.replace(/\/+$/, '') === '/world'
  if (!isWorld) return <App />
  return (
    <Suspense fallback={null}>
      <WorldApp />
    </Suspense>
  )
}
