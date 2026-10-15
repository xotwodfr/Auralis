// Minimal stand-in for the Web Audio API (jsdom has none). It records the graph the engine builds — nodes, connections
// and the latest value of every AudioParam — so tests can check the wiring and its lifecycle, not just UI state.
// Actual sound is verified in a real browser by e2e/effects.spec.ts.

import { vi } from 'vitest'

export class FakeParam {
  value: number
  /** Changes scheduled after `currentTime` (only `setValueAtTime` can schedule ahead here). */
  pending: { value: number; time: number }[] = []
  constructor(
    private ctx: FakeAudioContext,
    value: number,
  ) {
    this.value = value
  }
  setTargetAtTime(value: number) {
    this.value = value
    return this
  }
  setValueAtTime(value: number, time: number) {
    if (time <= this.ctx.currentTime) this.value = value
    else this.pending.push({ value, time })
    return this
  }
  cancelScheduledValues(time: number) {
    this.pending = this.pending.filter((p) => p.time < time)
    return this
  }
}

export class FakeNode {
  readonly outputs = new Set<FakeNode>()
  channelCount = 2
  channelCountMode = 'max'
  constructor(
    readonly ctx: FakeAudioContext,
    readonly kind: string,
  ) {
    ctx.nodes.push(this)
  }
  connect(target: FakeNode, output = 0, input = 0) {
    const key = `${this.ctx.nodes.indexOf(this)}>${this.ctx.nodes.indexOf(target)}:${output}:${input}`
    if (this.ctx.edges.has(key)) this.ctx.duplicateEdges.push(key)
    this.ctx.edges.add(key)
    this.outputs.add(target)
    return target
  }
  disconnect() {
    this.outputs.clear()
  }
  param(value = 0) {
    return new FakeParam(this.ctx, value)
  }
}

class FakeGain extends FakeNode {
  gain = this.param(1)
}
class FakeBiquad extends FakeNode {
  type = 'lowpass'
  frequency = this.param(350)
  Q = this.param(1)
  gain = this.param(0)
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048
  getFloatTimeDomainData(buf: Float32Array) {
    buf.fill(0)
  }
}
class FakeConvolver extends FakeNode {
  normalize = true
  buffer: unknown = null
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  nodes: FakeNode[] = []
  edges = new Set<string>()
  duplicateEdges: string[] = []
  sources: unknown[] = []
  state = 'suspended'
  currentTime = 0
  sampleRate = 48000
  destination = new FakeNode(this, 'destination')
  audioWorklet = { addModule: vi.fn(() => FakeAudioContext.workletLoad()) }
  resume = vi.fn(() => {
    this.state = 'running'
    return Promise.resolve()
  })
  /** Override to make the worklet module fail to load. */
  static workletLoad: () => Promise<void> = () => Promise.resolve()

  constructor() {
    FakeAudioContext.instances.push(this)
  }
  createGain() {
    return new FakeGain(this, 'gain')
  }
  createBiquadFilter() {
    return new FakeBiquad(this, 'biquad')
  }
  createAnalyser() {
    return new FakeAnalyser(this, 'analyser')
  }
  createChannelSplitter() {
    return new FakeNode(this, 'splitter')
  }
  createChannelMerger() {
    return new FakeNode(this, 'merger')
  }
  createConvolver() {
    return new FakeConvolver(this, 'convolver')
  }
  createMediaElementSource(el: unknown) {
    this.sources.push(el)
    return new FakeNode(this, 'source')
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return { numberOfChannels: channels, length, sampleRate, data, copyToChannel: (src: Float32Array, ch: number) => data[ch]!.set(src) }
  }

  /** Every node reachable downstream of `from`. */
  reachable(from: FakeNode): Set<FakeNode> {
    const seen = new Set<FakeNode>()
    const walk = (n: FakeNode) => {
      for (const o of n.outputs) {
        if (seen.has(o)) continue
        seen.add(o)
        walk(o)
      }
    }
    walk(from)
    return seen
  }
  of<T extends FakeNode>(kind: string): T[] {
    return this.nodes.filter((n) => n.kind === kind) as T[]
  }
}

export class FakeWorkletNode extends FakeNode {
  parameters: Map<string, FakeParam>
  constructor(
    ctx: FakeAudioContext,
    readonly name: string,
    readonly options: unknown,
  ) {
    super(ctx, 'worklet')
    this.parameters = new Map([['semitones', this.param(0)]])
  }
}

/** Installs the fakes as globals; undo with `vi.unstubAllGlobals()`. */
export function stubWebAudio() {
  FakeAudioContext.instances = []
  FakeAudioContext.workletLoad = () => Promise.resolve()
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
}

/** Lets the worklet's addModule promise chain settle. */
export const settle = () => new Promise((r) => setTimeout(r, 0))
