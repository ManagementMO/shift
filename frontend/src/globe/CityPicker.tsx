import { useId, useRef, useState } from 'react'
import { GodIcon } from '../gods-plan/icons'
import { GlassButton, GlassIconButton, GlassSurface } from '../gods-plan/ui'
import { searchLocations, type Location } from './flight'
import { CITY_IMAGES } from './cityImages'

interface Props {
  selected: Location | null
  hovered: string | null
  disabled: boolean
  error: string | null
  onChoose: (place: Location) => void
  onHover: (id: string | null) => void
}

export default function CityPicker({ selected, hovered, disabled, error, onChoose, onHover }: Props) {
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const title = useId()
  const places = searchLocations(query)
  const clear = () => { setQuery(''); input.current?.focus() }

  return (
    <GlassSurface tone="light" className="orbital-picker" role="region" aria-labelledby={title}>
      <h1 id={title}>Choose City</h1>
      <p className="orbital-picker-hint" id={`${title}-hint`} aria-live="polite">{selected ? `Click ${selected.name} again to enter.` : 'Select a city. Click again to enter.'}</p>
      {error && <p className="orbital-picker-error" role="alert">{error}</p>}
      <div className="orbital-search">
        <GodIcon name="search" size={20} />
        <input ref={input} type="search" aria-label="Search cities" placeholder="Search cities…" value={query} disabled={disabled} autoComplete="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Escape' && query) { event.stopPropagation(); clear() }
          if (event.key === 'Enter' && places.length === 1 && !disabled) onChoose(places[0])
        }} />
        {query && <GlassIconButton icon="close" label="Clear search" size={16} disabled={disabled} onClick={clear} />}
      </div>
      <ul className="orbital-cities" aria-label="Cities" hidden={places.length === 0}>
        {places.map((place) => <li key={place.id}><button type="button" className="orbital-city" data-city={place.id} data-hovered={hovered === place.id} aria-label={`${selected?.id === place.id ? 'Enter' : 'Choose'} ${place.name}`} aria-describedby={`${title}-hint`} aria-pressed={selected?.id === place.id} disabled={disabled} onClick={() => onChoose(place)} onPointerEnter={() => onHover(place.id)} onPointerLeave={() => onHover(null)} onFocus={() => onHover(place.id)} onBlur={() => onHover(null)}>
          <span className="orbital-city-image" aria-hidden="true"><GodIcon name="building" size={24} />{CITY_IMAGES[place.id] && <img src={CITY_IMAGES[place.id].src} alt="" width={60} height={60} loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true }} />}</span>
          <span className="orbital-city-name">{place.name}</span>
          {selected?.id === place.id && <GodIcon name="arrow-right" className="orbital-city-selected" size={20} />}
        </button></li>)}
      </ul>
      {places.length === 0 && <div className="orbital-no-cities" role="status"><span>No cities found.</span><GlassButton variant="ghost" disabled={disabled} onClick={clear}>Clear search</GlassButton></div>}
      <span className="gp-sr-only" role="status">{query ? `${places.length} ${places.length === 1 ? 'city' : 'cities'} found` : ''}</span>
    </GlassSurface>
  )
}
