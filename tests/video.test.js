import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeVideo } from '../src/video.js';

const frame = delay => ({bytes: new Uint8Array([137, 80, 78, 71]), delay});

// Node has no WebCodecs or image decoder. Mock those browser boundaries while
// retaining the actual muxer and reading the resulting MP4 sample table.
function browserVideo(t, options = {}) {
  const names = ['VideoEncoder', 'VideoFrame', 'EncodedVideoChunk', 'EncodedAudioChunk', 'OffscreenCanvas', 'createImageBitmap'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const state = {decoded: 0, bitmapsClosed: 0, framesClosed: 0, encoderClosed: 0, encoded: [], configurations: [], canvases: [], draws: []};
  globalThis.createImageBitmap = async () => {
    const index = state.decoded++;
    if (options.decodeError) throw new Error('bad image');
    const sizes = options.dimensions || [[3, 5]];
    const [width, height] = sizes[Math.min(index, sizes.length - 1)];
    return {width, height, close() { state.bitmapsClosed++; }};
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; state.canvases.push([width, height]); }
    getContext() {
      return {fillStyle: '', fillRect() {}, drawImage(...args) { state.draws.push(args.slice(1)); }};
    }
  };
  globalThis.VideoFrame = class {
    constructor(canvas, timing) { Object.assign(this, timing); this.codedWidth = canvas.width; this.codedHeight = canvas.height; }
    close() { state.framesClosed++; }
  };
  globalThis.EncodedVideoChunk = class {
    constructor(init) { Object.assign(this, init); this.byteLength = options.chunkBytes || 6; }
    copyTo(target) { target.set([0, 0, 0, 2, 0x65, 0x88]); }
  };
  globalThis.EncodedAudioChunk = class {};
  globalThis.VideoEncoder = class {
    static async isConfigSupported(config) { return {supported: options.supported ? options.supported(config) : true, config}; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.pending = []; }
    configure(config) {
      assert.equal(config.latencyMode, 'quality');
      assert.equal(Object.hasOwn(config, 'framerate'), false);
      state.configurations.push(config);
      this.config = config;
      this.state = 'configured';
      if (options.configureError) throw new Error('configuration failed');
    }
    encode(input, encodeOptions) {
      state.encoded.push({timestamp: input.timestamp, duration: input.duration, keyFrame: encodeOptions.keyFrame});
      this.pending.push({timestamp: input.timestamp, duration: input.duration});
      if (options.onEncode) options.onEncode();
    }
    async flush() {
      if (options.hangFlush) return new Promise(() => {});
      if (options.encoderError) {
        this.callbacks.error(new Error('hardware failed'));
        throw new Error('hardware failed');
      }
      for (const input of this.pending.splice(0)) {
        if (options.omit) continue;
        const chunk = new EncodedVideoChunk({type: 'key', timestamp: input.timestamp + (options.shift || 0), duration: null});
        const meta = {decoderConfig: {
          codec: this.config.codec, codedWidth: this.config.width, codedHeight: this.config.height,
          description: this.config.codec.startsWith('avc') ? new Uint8Array([1, 66, 0, 31, 255, 225, 0, 1, 103, 1, 0, 1, 104]) : undefined,
        }};
        this.callbacks.output(chunk, meta);
        if (options.duplicate) this.callbacks.output(chunk, meta);
      }
    }
    close() { this.state = 'closed'; this.pending.length = 0; state.encoderClosed++; }
  };
  return state;
}

function mp4Timing(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const boxes = new Map();
  function scan(start, end) {
    for (let offset = start; offset + 8 <= end;) {
      let size = view.getUint32(offset);
      const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
      let header = 8;
      if (size === 1) { size = Number(view.getBigUint64(offset + 8)); header = 16; }
      assert.ok(size >= header && offset + size <= end, `valid ${type} box`);
      boxes.set(type, offset + header);
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) scan(offset + header, offset + size);
      offset += size;
    }
  }
  scan(0, bytes.byteLength);
  const mdhd = boxes.get('mdhd');
  const timeOffset = bytes[mdhd] === 1 ? 20 : 12;
  const timescale = view.getUint32(mdhd + timeOffset);
  const stts = boxes.get('stts');
  const deltas = [];
  for (let i = 0; i < view.getUint32(stts + 4); i++) {
    const count = view.getUint32(stts + 8 + i * 8);
    const delta = view.getUint32(stts + 12 + i * 8);
    for (let j = 0; j < count; j++) deltas.push(delta);
  }
  return {timescale, deltas};
}

test('video retains every variable millisecond delay including the long final frame', async t => {
  const state = browserVideo(t);
  const progress = [];
  const result = await encodeVideo([7, 13, 1001, 60000].map(frame), {onProgress: n => progress.push(n)});
  assert.equal(result.extension, 'mp4');
  assert.equal(result.mimeType, 'video/mp4');
  assert.deepEqual(mp4Timing(result.bytes), {timescale: 1000, deltas: [7, 13, 1001, 60000]});
  assert.deepEqual(state.encoded.map(({timestamp, duration}) => [timestamp, duration]), [[0, 7000], [7000, 13000], [20000, 1001000], [1021000, 60000000]]);
  assert.deepEqual(progress, [1, 2, 3, 4]);
  assert.equal(state.bitmapsClosed, 4);
  assert.equal(state.framesClosed, 4);
  assert.equal(state.encoderClosed, 1);
});

test('video keeps the only frame duration and pads AVC without stretching', async t => {
  const state = browserVideo(t);
  const result = await encodeVideo([frame(655360)]);
  assert.deepEqual(mp4Timing(result.bytes).deltas, [655360]);
  assert.deepEqual(state.canvases, [[4, 6]]);
  assert.deepEqual(state.draws, [[0, 0, 3, 5]]);
});

test('video shrinks the longest side to 1920 without enlarging other inputs', async t => {
  const state = browserVideo(t, {dimensions: [[4000, 2001]]});
  await encodeVideo([frame(10)]);
  assert.deepEqual(state.canvases, [[1920, 960]]);
  assert.deepEqual(state.draws, [[0, 0, 1920, 960]]);
});

test('video falls back to VP9 or VP8 WebM when earlier codecs are unsupported', async t => {
  for (const codec of ['vp09.00.10.08', 'vp8']) {
    await t.test(codec, async sub => {
      const state = browserVideo(sub, {supported: config => config.codec === codec});
      const result = await encodeVideo([frame(7), frame(9000)]);
      assert.equal(result.extension, 'webm');
      assert.equal(result.mimeType, 'video/webm');
      assert.deepEqual([...result.bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
      assert.equal(state.configurations[0].codec, codec);
      assert.deepEqual(state.canvases, [[3, 5]]);
    });
  }
});

test('video rejects unavailable codecs and releases the first decoded image', async t => {
  const state = browserVideo(t, {supported: () => false});
  await assert.rejects(encodeVideo([frame(50)]), /编码器|支持/);
  assert.equal(state.bitmapsClosed, 1);
  assert.equal(state.encoded.length, 0);
});

test('video rejects invalid delays and bytes instead of rounding them', async t => {
  browserVideo(t);
  for (const delay of [0, -1, 0.5, NaN, Infinity, '30', Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(encodeVideo([frame(delay)]), /时序|安全范围/);
  }
  for (const bytes of [null, [], new Uint8Array()]) {
    await assert.rejects(encodeVideo([{bytes, delay: 10}]), /字节/);
  }
  await assert.rejects(encodeVideo([]), /没有有效帧/);
});

test('video rejects a per-frame MP4 time delta beyond uint32 milliseconds', async t => {
  const state = browserVideo(t);
  await assert.rejects(encodeVideo([frame(0x1_0000_0000)]), /时序|时长/);
  assert.equal(state.bitmapsClosed, 1);
  assert.equal(state.encoded.length, 0);
});

test('video checks original dimensions even when different originals would scale identically', async t => {
  const state = browserVideo(t, {dimensions: [[4000, 2000], [4001, 2000]]});
  await assert.rejects(encodeVideo([frame(50), frame(50)]), /尺寸不一致/);
  assert.equal(state.bitmapsClosed, 2);
  assert.equal(state.encoderClosed, 1);
});

test('video rejects missing, duplicate or shifted encoder outputs', async t => {
  for (const options of [{omit: true}, {duplicate: true}, {shift: 1}]) {
    await t.test(JSON.stringify(options), async sub => {
      const state = browserVideo(sub, options);
      await assert.rejects(encodeVideo([frame(7), frame(13)]), /帧|时间戳|时序/);
      assert.equal(state.encoderClosed, 1);
      assert.equal(state.bitmapsClosed, 1);
    });
  }
});

test('video caps encoded bytes before copying a giant encoder chunk', async t => {
  const state = browserVideo(t, {chunkBytes: 256 * 1024 * 1024 + 1});
  await assert.rejects(encodeVideo([frame(50)]), /256 MiB/);
  assert.equal(state.encoderClosed, 1);
  assert.equal(state.bitmapsClosed, 1);
});

test('video reports image and encoder errors without masking them as successful fallback', async t => {
  for (const options of [{decodeError: true}, {encoderError: true}, {configureError: true}]) {
    await t.test(JSON.stringify(options), async sub => {
      const state = browserVideo(sub, options);
      await assert.rejects(encodeVideo([frame(50)]), /bad image|hardware failed|configuration failed/);
      assert.equal(state.bitmapsClosed, options.decodeError ? 0 : 1);
      if (!options.decodeError) assert.equal(state.encoderClosed, 1);
    });
  }
});

test('video consumes an async frame stream once and releases images before requesting more', async t => {
  const state = browserVideo(t);
  let requested = 0;
  async function* stream() {
    for (const delay of [7, 13, 1001]) {
      assert.equal(state.bitmapsClosed, requested);
      requested++;
      yield frame(delay);
    }
  }
  const result = await encodeVideo(stream());
  assert.equal(requested, 3);
  assert.deepEqual(mp4Timing(result.bytes).deltas, [7, 13, 1001]);
});

test('video cancellation stops requesting subsequent source frames', async t => {
  const state = browserVideo(t);
  const controller = new AbortController();
  let requested = 0;
  let returned = false;
  async function* stream() {
    try { for (let n = 0; n < 3; n++) { requested++; yield frame(50); } }
    finally { returned = true; }
  }
  await assert.rejects(encodeVideo(stream(), {signal: controller.signal, onProgress() { controller.abort(); }}), {name: 'AbortError'});
  assert.equal(requested, 1);
  assert.equal(returned, true);
  assert.equal(state.bitmapsClosed, 1);
  assert.equal(state.encoderClosed, 1);
});

test('video pre-cancellation occurs before consuming input', async t => {
  browserVideo(t);
  const controller = new AbortController();
  controller.abort();
  let requested = false;
  async function* stream() { requested = true; yield frame(50); }
  await assert.rejects(encodeVideo(stream(), {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(requested, false);
});

test('video cancellation interrupts an encoder flush that does not finish', async t => {
  const controller = new AbortController();
  const state = browserVideo(t, {hangFlush: true, onEncode() { setTimeout(() => controller.abort(), 0); }});
  await assert.rejects(encodeVideo([frame(50)], {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(state.bitmapsClosed, 1);
  assert.equal(state.encoderClosed, 1);
});
