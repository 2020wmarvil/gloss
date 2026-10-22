// The sound a finished turn makes (SPEC → Notifications): two soft sine notes, synthesized
// so no audio file ships with the app.

let context: AudioContext | null = null

/** Plays the chime; does nothing where Web Audio is missing (tests). */
export function playChime(): void {
  if (typeof AudioContext === 'undefined') return
  context ??= new AudioContext()
  const ctx = context
  void ctx.resume()
  const start = ctx.currentTime + 0.02
  // A rising fifth, E5 then B5, each fading out like a struck bell.
  for (const [i, freq] of [659.25, 987.77].entries()) {
    const at = start + i * 0.12
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.18, at + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + 0.95)
  }
}
