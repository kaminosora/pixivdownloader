import * as gifenc from 'gifenc';

// Node exposes this older CJS package through default; esbuild selects its ESM build.
const { GIFEncoder, quantize, applyPalette } = gifenc.GIFEncoder ? gifenc : gifenc.default;

const LIMITS = Object.freeze({sourceBytes: 128 * 1024 * 1024, frames: 600, pixels: 150_000_000, delayCs: 65535, outputBytes: 128 * 1024 * 1024, longestSide: 1280});
const LIMIT_REASONS = Object.freeze({
  'source-bytes': '动图原帧累计超过 128 MiB GIF 处理限制',
  'frame-count': 'GIF 超过 600 帧限制，无法生成',
  'scaled-pixels': 'GIF 缩放后累计超过 150M 像素限制，无法生成',
  delay: '单帧时长超过 GIF 时序上限，无法生成',
  'encoded-output': 'GIF 编码输出超过 128 MiB 限制',
});

/** Only these capacity errors are eligible for automatic video conversion. */
export class GifLimitError extends Error {
  constructor(reasonCode) {
    super(LIMIT_REASONS[reasonCode] || 'GIF 超过处理限制');
    this.name = 'GifLimitError';
    this.code = 'GIF_LIMIT';
    this.reasonCode = reasonCode;
  }
}

function validateMetadata(frames) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('动图没有有效帧');
  let durationMs = 0;
  for (const frame of frames) {
    if (!Number.isSafeInteger(frame?.delay) || frame.delay <= 0) throw new Error('动图毫秒时序无效');
    durationMs += frame.delay;
    if (!Number.isSafeInteger(durationMs)) throw new Error('动图毫秒时序超出安全范围');
  }
}

function scaledDimensions(width, height) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error('动图原帧尺寸无效');
  }
  const scale = Math.min(1, LIMITS.longestSide / Math.max(width, height));
  return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
}

/** Metadata dimensions are the original decoded dimensions, before GIF scaling. */
export function getGifLimitReason(metadata, {totalBytes = 0, width, height} = {}) {
  validateMetadata(metadata);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error('动图原帧字节统计无效');
  const size = width !== undefined || height !== undefined ? scaledDimensions(width, height) : null;
  if (totalBytes > LIMITS.sourceBytes) return LIMIT_REASONS['source-bytes'];
  if (metadata.length > LIMITS.frames) return LIMIT_REASONS['frame-count'];
  if (size && size.width * size.height * metadata.length > LIMITS.pixels) return LIMIT_REASONS['scaled-pixels'];
  let elapsedMs = 0;
  let elapsedCs = 0;
  for (const frame of metadata) {
    elapsedMs += frame.delay;
    const nextCs = Math.round(elapsedMs / 10);
    if (nextCs - elapsedCs > LIMITS.delayCs) return LIMIT_REASONS.delay;
    elapsedCs = nextCs;
  }
  return null;
}

function validateFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('动图没有有效帧');
  let bytes = 0;
  for (const frame of frames) {
    if (!frame || !(frame.bytes instanceof Uint8Array) || !frame.bytes.byteLength) throw new Error('动图原帧字节无效');
    bytes += frame.bytes.byteLength;
  }
  validateMetadata(frames);
  if (bytes > LIMITS.sourceBytes) throw new GifLimitError('source-bytes');
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
}

/** Convert sequentially so at most one decoded source frame is retained. */
export async function encodeGif(frames, { onProgress, signal } = {}) {
  checkAbort(signal);
  validateFrames(frames);
  if (frames.length > LIMITS.frames) throw new GifLimitError('frame-count');
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('浏览器不支持本地 GIF 转换');
  }
  const gif = GIFEncoder();
  let width, height, sourceWidth, sourceHeight, canvas, context;
  let pixels = 0;
  let elapsedMs = 0;
  let elapsedCs = 0;
  for (let i = 0; i < frames.length; i++) {
    checkAbort(signal);
    const frame = frames[i];
    const bitmap = await createImageBitmap(new Blob([frame.bytes]));
    try {
      checkAbort(signal);
      if (i === 0) {
        sourceWidth = bitmap.width;
        sourceHeight = bitmap.height;
        ({width, height} = scaledDimensions(sourceWidth, sourceHeight));
        if (width * height * frames.length > LIMITS.pixels) {
          throw new GifLimitError('scaled-pixels');
        }
        canvas = new OffscreenCanvas(width, height);
        context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('无法创建 GIF 绘图环境');
      } else if (bitmap.width !== sourceWidth || bitmap.height !== sourceHeight) {
        throw new Error('动图原帧尺寸不一致，无法生成 GIF');
      }
      pixels += width * height;
      if (pixels > LIMITS.pixels) throw new GifLimitError('scaled-pixels');
      context.clearRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const { data } = context.getImageData(0, 0, width, height);
      // GIF supports binary alpha only. Reserve index zero in every frame, even
      // opaque frames; disposal-to-background clears pixels before the next frame.
      const colors = quantize(data, 255, { format: 'rgb565' });
      const index = applyPalette(data, colors, 'rgb565');
      for (let p = 0; p < index.length; p++) index[p] = data[p * 4 + 3] < 128 ? 0 : index[p] + 1;
      const palette = [[0, 0, 0], ...colors];
      elapsedMs += frame.delay;
      const nextCs = Math.round(elapsedMs / 10);
      const delayCs = nextCs - elapsedCs;
      if (delayCs > LIMITS.delayCs) throw new GifLimitError('delay');
      elapsedCs = nextCs;
      gif.writeFrame(index, width, height, {
        palette, delay: delayCs * 10, repeat: 0,
        transparent: true, transparentIndex: 0, dispose: 2,
      });
      if (gif.bytesView().byteLength > LIMITS.outputBytes) throw new GifLimitError('encoded-output');
    } finally {
      bitmap.close();
    }
    onProgress?.(i + 1, frames.length);
    // Yield between frames so cancellation and UI updates can be delivered.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  checkAbort(signal);
  gif.finish();
  if (gif.bytesView().byteLength > LIMITS.outputBytes) throw new GifLimitError('encoded-output');
  return gif.bytes();
}
