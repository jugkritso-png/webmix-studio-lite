/* WebMix Lite — noise gate (AudioWorklet), same behaviour as WebMix Pro:
   opens fast (~2 ms), holds 150 ms, closes over ~120 ms, closes 6 dB under the threshold
   to avoid chatter, and only ducks by 40 dB so it still sounds natural. */
class WebMixGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: -100, minValue: -100, maxValue: 0, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    const sr = sampleRate;
    this.env = 0;
    this.gain = 1;
    this.holdLeft = 0;
    this.open = true;
    this.envDecay = Math.exp(-1 / (0.01 * sr));
    this.attack = 1 - Math.exp(-1 / (0.002 * sr));
    this.release = 1 - Math.exp(-1 / (0.12 * sr));
    this.holdSamples = Math.round(0.15 * sr);
    this.floor = 0.01;
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input.length) return true;
    const thr = Math.pow(10, params.threshold[0] / 20), close = thr * 0.5;
    const n = input[0].length, chs = input.length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < chs; c++) { const v = Math.abs(input[c][i]); if (v > peak) peak = v; }
      this.env = peak > this.env ? peak : this.env * this.envDecay;
      if (this.env >= thr) { this.open = true; this.holdLeft = this.holdSamples; }
      else if (this.env < close) { if (this.holdLeft > 0) this.holdLeft--; else this.open = false; }
      const target = this.open ? 1 : this.floor;
      this.gain += (target - this.gain) * (target > this.gain ? this.attack : this.release);
      for (let c = 0; c < chs; c++) if (output[c]) output[c][i] = input[c][i] * this.gain;
    }
    return true;
  }
}
registerProcessor('webmix-gate', WebMixGate);
