import test from 'node:test';
import assert from 'node:assert/strict';
import {convertAnimation as convert} from '../src/animation.js';
const metadata = (delays = [34, 67, 125]) => delays.map((delay, index) => ({file: `${index}.png`, url: `https://example.test/${index}.png`, delay}));
const rawFrame = index => new Uint8Array([137, 80, 78, 71, index]);
const videoResult = {bytes: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4', extension: 'mp4'};

function browserPixels(t, {dimensions = () => [1, 1], decodeError} = {}) {
  const originals = new Map(['createImageBitmap', 'OffscreenCanvas'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const closed = [];
  globalThis.createImageBitmap = async blob => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const index = bytes[4] || 0;
    if (decodeError?.(index)) throw new Error('损坏的原图');
    const [width, height] = dimensions(index);
    return {width, height, close() { closed.push(index); }};
  };
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {clearRect() {}, drawImage() {}, getImageData() { return {data: new Uint8ClampedArray([255, 0, 0, 255])}; }};
    }
  };
  return closed;
}

function reportLargeGif(t) {
  const original = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'byteLength');
  const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
  Object.defineProperty(Uint8Array.prototype, 'byteLength', {configurable: true, get() {
    return this[0] === 71 && this[1] === 73 && this[2] === 70 ? 128 * 1024 * 1024 + 1 : getter.call(this);
  }});
  t.after(() => original ? Object.defineProperty(Uint8Array.prototype, 'byteLength', original) : delete Uint8Array.prototype.byteLength);
}

test('ordinary animation produces the real GIF and downloads each original only once', async t => {
  const closed = browserPixels(t);
  const loaded = [], progress = [];
  const result = await convert(metadata(), {
    loadFrame: async (frame, index) => { loaded.push([frame.file, index]); return rawFrame(index); },
    encodeVideo: async () => assert.fail('a normal GIF must not enter video conversion'),
    onProgress: event => progress.push(event),
  });
  assert.deepEqual(loaded, [['0.png', 0], ['1.png', 1], ['2.png', 2]]);
  assert.deepEqual({...result, bytes: undefined}, {bytes: undefined, mimeType: 'image/gif', extension: 'gif', fallbackReason: null});
  assert.equal(new TextDecoder().decode(result.bytes.slice(0, 6)), 'GIF89a');
  assert.equal(result.bytes.at(-1), 0x3b);
  assert.deepEqual(closed, [0, 0, 1, 2]);
  assert.deepEqual(progress.filter(e => e.phase === 'download').map(e => e.completed), [1, 2, 3]);
  assert.equal(progress.at(-1).phase, 'gif');
  assert.equal(progress.at(-1).completed, 3);
});

test('known frame-count and timing limits start video before requesting any original', async () => {
  for (const [input, pattern] of [[metadata(Array(601).fill(17)), /600/], [metadata([34, 655_360, 125]), /时序/]]) {
    const order = [], delays = [], events = [];
    const signal = new AbortController().signal;
    const result = await convert(input, {
      signal,
      loadFrame: async (frame, index, frameSignal) => { assert.equal(frameSignal, signal); order.push(`load:${index}`); return rawFrame(index); },
      encodeVideo: async (iterable, options) => {
        assert.equal(options.signal, signal);
        order.push('video');
        for await (const frame of iterable) {
          const index = delays.length;
          delays.push(frame.delay);
          order.push(`encode:${index}`);
          options.onProgress(index + 1);
        }
        return videoResult;
      },
      onProgress: event => events.push(event),
    });
    assert.deepEqual(order.slice(0, 5), ['video', 'load:0', 'encode:0', 'load:1', 'encode:1']);
    assert.deepEqual(delays, input.map(frame => frame.delay));
    assert.deepEqual({...result, fallbackReason: undefined}, {...videoResult, fallbackReason: undefined});
    assert.match(result.fallbackReason, pattern);
    assert.equal(events[0].phase, 'fallback');
    assert.match(events[0].reason, pattern);
    assert.equal(events.at(-1).phase, 'video');
    assert.equal(events.at(-1).total, input.length);
  }
});

test('pixel preflight selects video after only the first original has been fetched', async t => {
  const closed = browserPixels(t, {dimensions: () => [2560, 2560]});
  const loaded = [], delays = [];
  const result = await convert(metadata(Array(92).fill(20)), {
    loadFrame: async (_frame, index) => { loaded.push(index); return rawFrame(index); },
    encodeVideo: async iterable => {
      assert.deepEqual(loaded, [0]);
      for await (const frame of iterable) delays.push(frame.delay);
      return videoResult;
    },
  });
  assert.match(result.fallbackReason, /150M/);
  assert.equal(loaded.length, 92);
  assert.equal(new Set(loaded).size, 92);
  assert.deepEqual(closed, [0]);
  assert.deepEqual(delays, Array(92).fill(20));
});

test('crossing the raw GIF budget drains buffered frames before streaming further downloads', async t => {
  browserPixels(t);
  // Reuse one allocation: logical source size is 131 MiB while test RAM is small.
  const shared = new Uint8Array(1024 * 1024);
  const order = [];
  const result = await convert(metadata(Array(131).fill(33)), {
    loadFrame: async (_frame, index) => { order.push(`load:${index}`); return shared; },
    encodeVideo: async iterable => {
      order.push('video');
      let index = 0;
      for await (const frame of iterable) {
        assert.equal(frame.bytes, shared);
        assert.equal(frame.delay, 33);
        order.push(`encode:${index++}`);
      }
      assert.equal(index, 131);
      return videoResult;
    },
  });
  assert.match(result.fallbackReason, /128 MiB/);
  assert.equal(order.filter(item => item.startsWith('load:')).length, 131);
  assert.equal(order[129], 'video');
  assert.deepEqual(order.slice(-7), ['encode:126', 'encode:127', 'encode:128', 'load:129', 'encode:129', 'load:130', 'encode:130']);
});

test('encoded GIF output limit reuses all downloaded frames without fetching again', async t => {
  browserPixels(t);
  reportLargeGif(t);
  const loaded = [], received = [];
  const result = await convert(metadata(), {
    loadFrame: async (_frame, index) => { loaded.push(index); return rawFrame(index); },
    encodeVideo: async iterable => {
      for await (const frame of iterable) received.push([frame.bytes[4], frame.delay]);
      return {...videoResult, mimeType: 'video/webm', extension: 'webm'};
    },
  });
  assert.match(result.fallbackReason, /编码输出/);
  assert.equal(result.extension, 'webm');
  assert.equal(result.mimeType, 'video/webm');
  assert.deepEqual(loaded, [0, 1, 2]);
  assert.deepEqual(received, [[0, 34], [1, 67], [2, 125]]);
});

test('malformed metadata, invalid bytes and network failures never trigger video', async t => {
  browserPixels(t);
  const encodeVideo = async () => assert.fail('ordinary errors must not select video');
  for (const delays of [[], [0], [Number.MAX_SAFE_INTEGER, 1], [655_360, 0]]) {
    await assert.rejects(convert(metadata(delays), {loadFrame: async () => assert.fail('invalid metadata must not download'), encodeVideo}), /帧|时序|安全范围/);
  }
  await assert.rejects(convert(metadata(), {loadFrame: async () => new Uint8Array(), encodeVideo}), /字节/);
  const failure = new Error('HTTP 403');
  await assert.rejects(convert(metadata(), {loadFrame: async () => {throw failure;}, encodeVideo}), error => error === failure);
});

test('image decode failures remain conversion failures', async t => {
  const encodeVideo = async () => assert.fail('image errors must not select video');
  browserPixels(t, {decodeError: index => index === 1});
  await assert.rejects(convert(metadata(), {loadFrame: async (_frame, index) => rawFrame(index), encodeVideo}), /损坏/);
});

test('frame-size mismatches remain conversion failures', async t => {
  const encodeVideo = async () => assert.fail('image errors must not select video');
  browserPixels(t, {dimensions: index => [index + 1, 1]});
  await assert.rejects(convert(metadata(), {loadFrame: async (_frame, index) => rawFrame(index), encodeVideo}), /尺寸不一致/);
});

test('pre-cancellation and cancellation during downloading stop before the next original', async t => {
  browserPixels(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(convert(metadata(), {signal: controller.signal, loadFrame: async () => assert.fail('cancelled job downloaded'), encodeVideo: async () => assert.fail('cancelled job encoded')}), {name: 'AbortError'});
  const active = new AbortController(), loaded = [];
  await assert.rejects(convert(metadata(), {
    signal: active.signal,
    loadFrame: async (_frame, index) => {loaded.push(index); active.abort(); return rawFrame(index);},
    encodeVideo: async () => assert.fail('cancelled job encoded'),
  }), {name: 'AbortError'});
  assert.deepEqual(loaded, [0]);
});

test('cancellation during video consumption stops further downloads', async () => {
  const controller = new AbortController(), loaded = [];
  await assert.rejects(convert(metadata([655_360, 10, 20]), {
    signal: controller.signal,
    loadFrame: async (_frame, index) => {loaded.push(index); return rawFrame(index);},
    encodeVideo: async iterable => {
      for await (const _frame of iterable) controller.abort();
      return videoResult;
    },
  }), {name: 'AbortError'});
  assert.deepEqual(loaded, [0]);
});

test('cancellation after GIF progress cannot be converted into a video fallback', async t => {
  browserPixels(t);
  const controller = new AbortController();
  await assert.rejects(convert(metadata(), {
    signal: controller.signal,
    loadFrame: async (_frame, index) => rawFrame(index),
    onProgress: event => {if (event.phase === 'gif' && event.completed === 1) controller.abort();},
    encodeVideo: async () => assert.fail('cancelled GIF encoded a video'),
  }), {name: 'AbortError'});
});

test('a video encoder failure is returned unchanged with no second conversion attempt', async () => {
  const failure = new Error('当前平台不支持视频编码');
  await assert.rejects(convert(metadata([655_360]), {
    loadFrame: async () => assert.fail('unsupported video codec fetched frames'),
    encodeVideo: async () => {throw failure;},
  }), error => error === failure);
});
