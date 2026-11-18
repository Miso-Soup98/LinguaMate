// Send one mono block per 64 ms at the capture context's 16 kHz sample rate.
class LinguaMateCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1024);
    this.used = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) {
      this.used = 0;
      return true;
    }
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(this.block.length - this.used, input.length - offset);
      this.block.set(input.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      if (this.used === this.block.length) {
        const samples = this.block;
        this.port.postMessage({ samples, endTime: (currentFrame + offset) / sampleRate }, [samples.buffer]);
        this.block = new Float32Array(1024);
        this.used = 0;
      }
    }
    // The output stays silent. Playback continues through the original video.
    return true;
  }
}
registerProcessor("linguamate-capture", LinguaMateCapture);
