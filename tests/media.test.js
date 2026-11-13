import test from 'node:test';
import assert from 'node:assert/strict';
import * as media from '../src/media.js';
const { encodeGif } = media;

const frames = () => [
  { delay: 34, bytes: new Uint8Array([255, 216, 1, 9]) },
  { delay: 67, bytes: new Uint8Array([137, 80, 78, 71, 255]) },
];

// Node has no browser image decoder or canvas. Supply tiny pixel surfaces while
// exercising the real GIF encoder, timing, limits and bitmap lifecycle below.
function browserPixels(t, dimensions = [[1, 1]]) {
  const originals = new Map(['createImageBitmap', 'OffscreenCanvas'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  let index = 0;
  const closed = [];
  globalThis.createImageBitmap = async () => {
    const frameIndex = index++;
    const [width, height] = dimensions[Math.min(frameIndex, dimensions.length - 1)];
    return {width, height, close() { closed.push(frameIndex); }};
  };
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {clearRect() {}, drawImage() {}, getImageData() { return {data: new Uint8ClampedArray([255, 0, 0, 255])}; }};
    }
  };
  return closed;
}

function noZipError(pattern) {
  return error => {
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /ZIP/i);
    return true;
  };
}

test('GIF rejects empty frames, invalid bytes and non-positive millisecond timing', async () => {
  await assert.rejects(encodeGif([]), /帧/);
  for (const delay of [0, -1, NaN, Infinity, 1.5, '60']) {
    await assert.rejects(encodeGif([{ ...frames()[0], delay }]), /时序/);
  }
  for (const frame of [null, {}, { ...frames()[0], bytes: [] }, { ...frames()[0], bytes: new Uint8Array() }]) {
    await assert.rejects(encodeGif([frame]), /字节/);
  }
  await assert.rejects(encodeGif([{...frames()[0], delay: Number.MAX_SAFE_INTEGER}, frames()[1]]), /安全范围/);
});

test('GIF enforces the cumulative original 128 MiB bound before decoding', async () => {
  const bytes = new Uint8Array(64 * 1024 * 1024 + 1);
  const input = [{ file: 'a.jpg', delay: 100, bytes }, { file: 'b.jpg', delay: 100, bytes }];
  await assert.rejects(encodeGif(input), /128 MiB/);
});

test('GIF frame cap reports failure without suggesting an unsaved ZIP', async () => {
  const input = Array.from({ length: 601 }, (_, n) => ({...frames()[0], file: `${n}.jpg`}));
  await assert.rejects(encodeGif(input), noZipError(/600/));
});

test('GIF supports pre-cancellation before validation or decoding', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(encodeGif(frames(), { signal: controller.signal }), { name: 'AbortError' });
});

test('GIF converts raw frame bytes and timing without archive filenames', async (t) => {
  const closed = browserPixels(t);
  const bytes = await encodeGif(frames());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 6)), 'GIF89a');
  assert.equal(bytes.at(-1), 0x3b);
  assert.deepEqual(closed, [0, 1]);
});

test('GIF pixel cap stops oversized jobs before allocating a drawing surface', async (t) => {
  const closed = browserPixels(t, [[1280, 1280]]);
  const input = Array.from({length: 92}, (_, n) => ({...frames()[0], file: `${n}.png`}));
  await assert.rejects(encodeGif(input), noZipError(/150M/));
  assert.deepEqual(closed, [0]);
});

test('GIF dimension mismatch reports failure and releases both bitmaps', async (t) => {
  const closed = browserPixels(t, [[1, 1], [2, 1]]);
  await assert.rejects(encodeGif(frames().map((frame, n) => ({...frame, file: `${n}.png`}))), noZipError(/尺寸不一致/));
  assert.deepEqual(closed, [0, 1]);
});

test('GIF timing overflow reports failure and releases the bitmap', async (t) => {
  const closed = browserPixels(t);
  await assert.rejects(encodeGif([{...frames()[0], file: '0.png', delay: 655_360}]), noZipError(/时序上限/));
  assert.deepEqual(closed, [0]);
});

test('GIF cancellation between frames stops decoding and closes processed bitmap', async (t) => {
  const closed = browserPixels(t);
  const controller = new AbortController();
  await assert.rejects(encodeGif(frames(), {signal: controller.signal, onProgress() { controller.abort(); }}), {name: 'AbortError'});
  assert.deepEqual(closed, [0]);
});

test('GIF capacity failures carry structured reasons while invalid input does not', async (t) => {
  browserPixels(t, [[1280, 1280]]);
  const sharedBytes = new Uint8Array(1024 * 1024);
  const cases = [
    [Array.from({length: 129}, () => ({bytes: sharedBytes, delay: 50})), 'source-bytes'],
    [Array.from({length: 601}, () => frames()[0]), 'frame-count'],
    [Array.from({length: 92}, () => frames()[0]), 'scaled-pixels'],
    [[{...frames()[0], delay: 655_360}], 'delay'],
  ];
  for (const [input, reasonCode] of cases) {
    await assert.rejects(encodeGif(input), error => {
      assert.equal(error.code, 'GIF_LIMIT');
      assert.equal(error.reasonCode, reasonCode);
      assert.ok(error instanceof media.GifLimitError);
      return true;
    });
  }
  await assert.rejects(encodeGif([{...frames()[0], delay: 0}]), error => error.code !== 'GIF_LIMIT');
});

test('GIF preflight uses source dimensions and cumulative centisecond rounding', () => {
  assert.equal(typeof media.getGifLimitReason, 'function');
  const metadata = Array.from({length: 92}, () => ({delay: 50}));
  assert.equal(media.getGifLimitReason(metadata), null);
  assert.match(media.getGifLimitReason(metadata, {width: 2560, height: 2560}), /150M/);
  assert.equal(media.getGifLimitReason(metadata, {width: 2560, height: 1280}), null);
  assert.equal(media.getGifLimitReason([{delay: 655_354}]), null);
  assert.match(media.getGifLimitReason([{delay: 4}, {delay: 655_351}]), /时序/);
  assert.equal(media.getGifLimitReason([{delay: 5}, {delay: 655_354}]), null);
  assert.equal(media.getGifLimitReason([{delay: 1}], {totalBytes: 128 * 1024 * 1024}), null);
  assert.match(media.getGifLimitReason([{delay: 1}], {totalBytes: 128 * 1024 * 1024 + 1}), /128 MiB/);
  assert.throws(() => media.getGifLimitReason([{delay: 0}]), error => error.code !== 'GIF_LIMIT');
  assert.throws(() => media.getGifLimitReason([{delay: 1}], {width: 0, height: 1}), error => error.code !== 'GIF_LIMIT');
});

test('GIF encoded-output budget is checked before copying the completed stream', async (t) => {
  const closed = browserPixels(t);
  // Exercise the real encoder with a small surface, but report a logical large
  // byte length for its GIF output view so this boundary test needs no 128 MiB GIF.
  const original = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'byteLength');
  const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
  Object.defineProperty(Uint8Array.prototype, 'byteLength', {configurable: true, get() {
    return this[0] === 71 && this[1] === 73 && this[2] === 70 ? 128 * 1024 * 1024 + 1 : getter.call(this);
  }});
  t.after(() => original ? Object.defineProperty(Uint8Array.prototype, 'byteLength', original) : delete Uint8Array.prototype.byteLength);
  await assert.rejects(encodeGif(frames()), error => {
    assert.equal(error.code, 'GIF_LIMIT');
    assert.equal(error.reasonCode, 'encoded-output');
    return true;
  });
  assert.deepEqual(closed, [0]);
});
