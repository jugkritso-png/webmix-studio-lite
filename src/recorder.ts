// Records the Program canvas plus the master audio bus with MediaRecorder.
import { recordAudioTracks } from './audio';

/* ---------- recording ---------- */

function pickMime(): string {
  const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export class Recorder {
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  readonly started = performance.now();

  constructor(canvas: HTMLCanvasElement, fps = 30) {
    const video = canvas.captureStream(fps);
    const px = canvas.width * canvas.height;
    const bitrate = Math.round((px >= 3840 * 2160 ? 35e6 : px >= 1920 * 1080 ? 10e6 : 6e6) * (fps > 30 ? 1.5 : 1));
    const stream = new MediaStream([...video.getVideoTracks(), ...recordAudioTracks()]);
    const mimeType = pickMime();
    this.rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: bitrate } : undefined);
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(1000);
  }

  get mime(): string {
    return this.rec.mimeType || 'video/webm';
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.mime }));
      this.rec.stop();
    });
  }
}
