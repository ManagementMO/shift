import { GlassSurface } from '../gods-plan/ui'
import { SettingsPanel } from '../shell/SimulationSettings'
import { CITY_IMAGES } from './cityImages'
import { LOCATIONS } from './flight'

interface Props {
  id: string
  disabled: boolean
  monochrome: boolean
  setMonochrome: (value: boolean) => void
  onClose: () => void
}

export default function GlobeSettings({ id, disabled, monochrome, setMonochrome, onClose }: Props) {
  return (
    <GlassSurface id={id} tone="light" className="orbital-settings" inert={disabled}>
      <SettingsPanel docked appearance={{ monochrome, setMonochrome }} onClose={onClose} />
      <details className="orbital-credits">
        <summary>Image credits</summary>
        <div>
          <a href="https://github.com/mrdoob/three.js" target="_blank" rel="noreferrer">Earth imagery · three.js</a>
          <a href="https://github.com/nvkelso/natural-earth-vector" target="_blank" rel="noreferrer">Country boundaries · Natural Earth</a>
          {Object.entries(CITY_IMAGES).map(([city, image]) => <span key={city}><a href={image.source} target="_blank" rel="noreferrer">{LOCATIONS.find((place) => place.id === city)?.name} · {image.author}</a><a href={image.licenseUrl} target="_blank" rel="noreferrer">{image.license}</a></span>)}
          <small>City photographs are cropped to circular thumbnails.</small>
        </div>
      </details>
    </GlassSurface>
  )
}
