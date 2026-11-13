import {encodeGif, getGifLimitReason, GifLimitError} from './media.js';

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
}

/**
 * loadFrame(metadata, index, signal) returns the original Uint8Array.
 * encodeVideo consumes an async iterable of {bytes, delay, file}; it must apply
 * backpressure and validate/decode frames as it consumes them.
 */
export async function convertAnimation(metadata, {loadFrame, encodeVideo, signal, onProgress} = {}) {
  checkAbort(signal);
  // Validate every delay before selecting either format. A malformed late frame
  // must not be hidden by an earlier GIF capacity limit.
  const knownReason = getGifLimitReason(metadata);
  if (typeof loadFrame !== 'function') throw new Error('缺少动图原帧下载器');
  const total = metadata.length;
  const buffered = [];
  let downloaded = 0;
  let totalBytes = 0;
  const progress = (phase, completed, reason) => onProgress?.({phase, completed, total, ...(reason ? {reason} : {})});

  async function loadNext() {
    checkAbort(signal);
    const frame = metadata[downloaded];
    const bytes = await loadFrame(frame, downloaded, signal);
    checkAbort(signal);
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error('动图原帧字节无效');
    totalBytes += bytes.byteLength;
    downloaded++;
    progress('download', downloaded);
    checkAbort(signal);
    return {bytes, delay: frame.delay, file: frame.file};
  }

  async function* videoFrames() {
    try {
      for (let index = 0; index < buffered.length; index++) {
        checkAbort(signal);
        const frame = buffered[index];
        // Remove the collector's reference before yielding: only the consumer
        // and this one suspended iteration can retain the current original.
        buffered[index] = null;
        yield frame;
      }
      buffered.length = 0;
      while (downloaded < total) yield await loadNext();
      checkAbort(signal);
    } finally {
      buffered.length = 0;
    }
  }

  async function toVideo(reason) {
    checkAbort(signal);
    if (typeof encodeVideo !== 'function') throw new Error('浏览器不支持本地视频转换');
    progress('fallback', 0, reason);
    checkAbort(signal);
    const iterable = videoFrames();
    try {
      const result = await encodeVideo(iterable, {
        signal,
        onProgress: completed => progress('video', completed),
      });
      checkAbort(signal);
      return {...result, fallbackReason: reason};
    } finally {
      // Also release buffered data if the encoder rejects before consuming the
      // iterable, or exits after only a subset of frames.
      await iterable.return();
      buffered.length = 0;
    }
  }

  try {
    if (knownReason) return await toVideo(knownReason);
    buffered.push(await loadNext());
    if (typeof createImageBitmap !== 'function') throw new Error('浏览器不支持本地 GIF 转换');
    const bitmap = await createImageBitmap(new Blob([buffered[0].bytes]));
    let reason;
    try {
      checkAbort(signal);
      reason = getGifLimitReason(metadata, {totalBytes, width: bitmap.width, height: bitmap.height});
    } finally {
      bitmap.close();
    }
    if (reason) return await toVideo(reason);

    while (downloaded < total) {
      buffered.push(await loadNext());
      reason = getGifLimitReason(metadata, {totalBytes});
      if (reason) return await toVideo(reason);
    }
    checkAbort(signal);
    progress('gif', 0);
    try {
      const bytes = await encodeGif(buffered, {signal, onProgress: completed => progress('gif', completed)});
      checkAbort(signal);
      return {bytes, mimeType: 'image/gif', extension: 'gif', fallbackReason: null};
    } catch (error) {
      checkAbort(signal);
      if (!(error instanceof GifLimitError)) throw error;
      return await toVideo(error.message);
    }
  } finally {
    buffered.length = 0;
  }
}
