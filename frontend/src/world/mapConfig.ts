import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined
export const USE_INTERLEAVED_MAPBOX_LAYERS = Boolean(MAPBOX_TOKEN)
export const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron'
export const MAPLIBRE_WORKER_URL = maplibreWorkerUrl
