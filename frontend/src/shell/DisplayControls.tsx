import { useDisplay } from '../babylon/display'

export default function DisplayControls() {
  const { shadows, textures, sharp, set } = useDisplay()
  return (
    <details className="display-panel glass">
      <summary><span>Display</span><span className="display-mode">{textures ? 'Textured' : 'Model'}</span></summary>
      <div className="display-options">
        <label><span>Sun shadows</span><input type="checkbox" checked={shadows} onChange={(e) => set({ shadows: e.target.checked })} /></label>
        <label><span>Surface textures</span><input type="checkbox" checked={textures} onChange={(e) => set({ textures: e.target.checked })} /></label>
        <label><span>High resolution</span><input type="checkbox" checked={sharp} onChange={(e) => set({ sharp: e.target.checked })} /></label>
        <span className="small dim">Display only. Recorded simulation data is unchanged.</span>
      </div>
    </details>
  )
}
