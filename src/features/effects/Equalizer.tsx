import { EQ_FREQS, EQ_RANGE_DB } from '../../audio/dsp'
import { EQ_PRESETS, FLAT_EQ, useSettings } from '../../state/settings'

const bandLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`)
const sameGains = (a: readonly number[], b: readonly number[]) => a.every((g, i) => g === b[i])
const signed = (db: number) => `${db > 0 ? '+' : ''}${db}`

/**
 * Presets, one vertical slider per band and a flat reset; shared by Now Playing's effects panel and the phone settings
 * page. The on/off switch stays with the caller, in that screen's own row style. `chip` is that screen's pill class.
 */
export function EqualizerBands({ chip }: { chip: string }) {
  const gains = useSettings((s) => s.eqGains)
  const setGains = useSettings((s) => s.setEqGains)
  return (
    <>
      <div className="eq__presets" role="group" aria-label="Equalizer presets">
        {EQ_PRESETS.map((p) => (
          <button key={p.name} type="button" className={chip} aria-pressed={sameGains(gains, p.gains)} onClick={() => setGains([...p.gains])}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="eq__bands">
        {EQ_FREQS.map((hz, i) => (
          <label key={hz} className="eq__band">
            <span className="eq__db">{signed(gains[i] ?? 0)}</span>
            <input
              type="range"
              className="eq__slider"
              aria-label={`${bandLabel(hz)} Hz`}
              aria-valuetext={`${signed(gains[i] ?? 0)} dB`}
              min={-EQ_RANGE_DB}
              max={EQ_RANGE_DB}
              step={0.5}
              value={gains[i]}
              onChange={(e) => setGains(gains.map((g, j) => (j === i ? Number(e.target.value) : g)))}
            />
            <span>{bandLabel(hz)}</span>
          </label>
        ))}
      </div>
      <button type="button" className={`${chip} eq__reset`} disabled={sameGains(gains, FLAT_EQ)} onClick={() => setGains([...FLAT_EQ])}>
        Reset to flat
      </button>
    </>
  )
}
