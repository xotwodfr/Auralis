// AudioWorklet entry: the pitch shifter, one per channel. At 0 semitones it outputs silence without doing any FFTs; the
// graph routes the dry signal around it then. Loaded with `?worker&url`, so it ships as its own same-origin file.

import { PitchShifter } from './pitchShifter'

// AudioWorkletGlobalScope is not in TypeScript's DOM lib.
declare class AudioWorkletProcessor {}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

class PitchProcessor extends AudioWorkletProcessor {
  static parameterDescriptors = [{ name: 'semitones', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' }]
  private channels: PitchShifter[] = []
  private idle = true

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const semitones = parameters.semitones?.[0] ?? 0
    if (semitones === 0) {
      this.idle = true
      return true // outputs start zeroed
    }
    if (this.idle) {
      for (const c of this.channels) c.reset() // stale frames from the last time would replay as an echo
      this.idle = false
    }
    const ratio = 2 ** (semitones / 12)
    const input = inputs[0] ?? []
    outputs[0]?.forEach((out, ch) => {
      const inp = input[ch]
      if (inp) (this.channels[ch] ??= new PitchShifter()).process(inp, out, ratio)
    })
    return true
  }
}

registerProcessor('auralis-pitch', PitchProcessor)
