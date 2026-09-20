import { useState } from 'react'
import { sendPopulationStimulus } from '../populationStimuli'

export default function PopulationTemperature() {
  const [temperature, setTemperature] = useState(30)
  return <form className="population-panel" onSubmit={event => {
    event.preventDefault()
    void sendPopulationStimulus({ kind: 'temperature', temperature_c: temperature, text: `The district temperature is now ${temperature}°C.`, duration_s: 600 })
  }}>
    <p>Residents observe the new temperature at their next decision boundary and choose their own response.</p>
    <label>Temperature (°C)<input aria-label="Swarm temperature" type="number" min={-40} max={50} value={temperature} onChange={e => setTemperature(Number(e.target.value))} /></label>
    <button className="primary" disabled={!Number.isFinite(temperature) || temperature < -40 || temperature > 50}>Send temperature to residents</button>
  </form>
}
