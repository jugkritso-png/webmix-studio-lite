/* WebMix Lite — loudness per ITU-R BS.1770 / EBU R128 (AudioWorklet).
   K-weighting (high-shelf + high-pass) per channel, then posts the mean square of every
   100 ms block; the page turns those into momentary, short-term and integrated LUFS. */
class LufsMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    this.s1 = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan(Math.PI * f0 / fs);
    a0 = 1 + K / Q + K * K;
    this.s2 = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
    this.z = [];
    this.block = Math.round(fs / 10);
    this.n = 0;
    this.sum = 0;
  }
  state(c) { return this.z[c] || (this.z[c] = [0, 0, 0, 0]); }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const len = inp[0].length, { s1, s2 } = this;
    const sq = new Float64Array(len);
    for (let c = 0; c < Math.min(2, inp.length); c++) {
      const x = inp[c], z = this.state(c);
      for (let i = 0; i < len; i++) {
        const v = x[i];
        const y1 = s1.b0 * v + z[0];
        z[0] = s1.b1 * v - s1.a1 * y1 + z[1];
        z[1] = s1.b2 * v - s1.a2 * y1;
        const y2 = s2.b0 * y1 + z[2];
        z[2] = s2.b1 * y1 - s2.a1 * y2 + z[3];
        z[3] = s2.b2 * y1 - s2.a2 * y2;
        sq[i] += y2 * y2;
      }
    }
    // a mono signal counts as both speakers, as the listener hears it
    const mono = inp.length === 1 ? 2 : 1;
    for (let i = 0; i < len; i++) {
      this.sum += sq[i] * mono;
      if (++this.n >= this.block) { this.port.postMessage(this.sum / this.n); this.sum = 0; this.n = 0; }
    }
    return true;
  }
}
registerProcessor('webmix-lufs', LufsMeter);
