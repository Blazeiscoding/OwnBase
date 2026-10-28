// Plays a microphone the desktop app opened itself (see systemMicrophone.ts).
// Its samples come on a MessagePort straight from the main process, so the
// page's own thread being busy never gaps the sound. A short buffer evens out
// how they arrive, and since the microphone's clock and the audio output's
// drift apart a little, the buffer is kept near its target by skipping or
// repeating one sample in a block, which cannot be heard.

/** How much sound to hold before playing, and to keep after: 20 ms. */
const TARGET_S = 0.02;
/** More than this held, after a stall or at the start, is cut back to the target. */
const MOST_S = 0.12;
/** Nothing for this long means the microphone stopped without saying so. */
const QUIET_S = 2;

class SystemMicrophoneSource extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(Math.ceil(sampleRate));
    this.read = 0;
    this.write = 0;
    this.held = 0;
    this.target = Math.round(sampleRate * TARGET_S);
    this.most = Math.round(sampleRate * MOST_S);
    this.playing = false;
    this.lastHeard = -1;
    this.ended = false;
    this.port.onmessage = (event) => {
      const source = event.data && event.data.port;
      if (source) source.onmessage = (message) => this.receive(message.data);
    };
  }

  receive(data) {
    if (data instanceof Float32Array) {
      this.push(data);
      this.lastHeard = currentTime;
    } else if (data && typeof data.ended === "string") {
      this.end(data.ended);
    }
  }

  push(samples) {
    const size = this.ring.length;
    // Only the newest second fits; anything older is late anyway.
    const from = Math.max(0, samples.length - size);
    for (let i = from; i < samples.length; i++) {
      this.ring[this.write] = samples[i];
      this.write = (this.write + 1) % size;
    }
    this.held = Math.min(size, this.held + samples.length - from);
    if (this.held > this.most) {
      const drop = this.held - this.target;
      this.read = (this.read + drop) % size;
      this.held -= drop;
    }
  }

  end(reason) {
    if (this.ended) return;
    this.ended = true;
    this.port.postMessage({ ended: reason });
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (this.ended) {
      out.fill(0);
      return true;
    }
    if (this.lastHeard >= 0 && currentTime - this.lastHeard > QUIET_S) this.end("stopped");
    if (!this.playing) {
      if (this.held < this.target) {
        out.fill(0);
        return true;
      }
      this.playing = true;
    }
    if (this.held <= out.length) {
      // Ran dry: silence until the buffer fills to its target again.
      out.fill(0);
      this.playing = false;
      return true;
    }
    // One sample skipped when too much is held, or one repeated when too
    // little, in the middle of the block.
    const skip = this.held > this.target * 2;
    const repeat = this.held < this.target / 2;
    const size = this.ring.length;
    const middle = out.length >> 1;
    let at = this.read;
    for (let i = 0; i < out.length; i++) {
      out[i] = this.ring[at];
      if (!(repeat && i === middle)) at = (at + 1) % size;
    }
    if (skip) at = (at + 1) % size;
    this.held -= (at - this.read + size) % size;
    this.read = at;
    return true;
  }
}

registerProcessor("ownbase-system-microphone", SystemMicrophoneSource);
