import {
  BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat,
  Output, WebMOutputFormat,
} from 'mediabunny';

const SOURCE_FRAME_LIMIT = 128 * 1024 * 1024;
const OUTPUT_LIMIT = 256 * 1024 * 1024;
const MAX_MP4_DELAY_MS = 0xffff_ffff;
const LONGEST_SIDE = 1920;

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
}

function checkFrame(frame, timestampUs) {
  if (!(frame?.bytes instanceof Uint8Array) || !frame.bytes.byteLength) {
    throw new Error('动图原帧字节无效');
  }
  if (frame.bytes.byteLength > SOURCE_FRAME_LIMIT) throw new Error('单个动图原帧超过 128 MiB 安全上限');
  if (!Number.isSafeInteger(frame.delay) || frame.delay <= 0) throw new Error('动图毫秒时序无效');
  const durationUs = frame.delay * 1000;
  if (!Number.isSafeInteger(durationUs) || !Number.isSafeInteger(timestampUs + durationUs)) {
    throw new Error('动图微秒时序超出安全范围');
  }
  return durationUs;
}

function scaledSize(width, height) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error('动图原帧尺寸无效');
  }
  const scale = Math.min(1, LONGEST_SIDE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function chooseCodec(size, signal) {
  const candidates = [
    ['avc', 'avc1.640034'], ['avc', 'avc1.420034'],
    ['avc', 'avc1.64002a'], ['avc', 'avc1.42002a'],
    ['vp9', 'vp09.00.51.08'], ['vp9', 'vp09.00.10.08'], ['vp8', 'vp8'],
  ];
  for (const [codec, codecString] of candidates) {
    checkAbort(signal);
    const width = codec === 'avc' ? size.width + size.width % 2 : size.width;
    const height = codec === 'avc' ? size.height + size.height % 2 : size.height;
    const config = {
      codec: codecString, width, height,
      bitrate: Math.max(2_000_000, Math.min(16_000_000, width * height * 5)),
      bitrateMode: 'variable', latencyMode: 'quality', alpha: 'discard',
      ...(codec === 'avc' ? {avc: {format: 'avc'}} : {}),
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      checkAbort(signal);
      if (support.supported) return {codec, config};
    } catch (error) {
      checkAbort(signal);
      // A platform may reject a syntactically valid but unavailable codec.
      // Encoding failures after configuration are surfaced to the caller.
      if (error?.name !== 'TypeError' && error?.name !== 'NotSupportedError') throw error;
    }
  }
  throw new Error('浏览器没有可用的视频编码器（H.264、VP9、VP8）');
}

/**
 * Encode a once-consumed stream of {bytes, delay} frames. Timing is derived only
 * from the original integer millisecond delays; progress reports completed frames.
 */
export async function encodeVideo(frames, {signal, onProgress} = {}) {
  checkAbort(signal);
  if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function'
      || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('浏览器不支持本地视频转换所需的 WebCodecs');
  }
  if (!frames || (typeof frames[Symbol.asyncIterator] !== 'function' && typeof frames[Symbol.iterator] !== 'function')) {
    throw new Error('动图没有有效帧流');
  }

  let encoder, output, source, target, canvas, context, choice, size;
  let sourceWidth, sourceHeight;
  let timestampUs = 0, submitted = 0, received = 0, encodedBytes = 0;
  let muxPending = Promise.resolve();
  let failure, rejectFailure;
  let active = true, succeeded = false;
  const pendingTiming = new Map();
  const failed = new Promise((_, reject) => { rejectFailure = reject; });
  // Error callbacks can run between awaits. Attach a rejection observer now.
  failed.catch(() => {});
  const recordFailure = error => {
    if (!active || failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    rejectFailure(failure);
  };
  const check = () => {
    checkAbort(signal);
    if (failure) throw failure;
  };
  const wait = async promise => {
    // The argument can synchronously trigger error() before returning an already
    // rejected promise. Observe it before checking that callback's failure flag.
    const work = Promise.resolve(promise);
    work.catch(() => {});
    check();
    let abort;
    const canceled = signal ? new Promise((_, reject) => {
      abort = () => reject(new DOMException('操作已取消', 'AbortError'));
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
    }) : new Promise(() => {});
    try {
      const result = await Promise.race([work, failed, canceled]);
      check();
      return result;
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  };

  try {
    for await (let frame of frames) {
      check();
      const durationUs = checkFrame(frame, timestampUs);
      const delayMs = frame.delay;
      const bitmap = await createImageBitmap(new Blob([frame.bytes]));
      // The decoded bitmap owns what encoding needs. Do not keep original bytes
      // alive while drawing, flushing, or asking a streamed source for its next item.
      frame = null;
      try {
        check();
        if (!choice) {
          sourceWidth = bitmap.width;
          sourceHeight = bitmap.height;
          size = scaledSize(sourceWidth, sourceHeight);
          choice = await chooseCodec(size, signal);
          check();
          target = new BufferTarget();
          target.on('write', ({end}) => {
            if (end > OUTPUT_LIMIT) recordFailure(new Error('视频输出超过 256 MiB 安全上限'));
          });
          output = new Output({
            target,
            format: choice.codec === 'avc' ? new Mp4OutputFormat({fastStart: false}) : new WebMOutputFormat(),
          });
          source = new EncodedVideoPacketSource(choice.codec);
          // MP4 uses this as a timescale, while WebM is already millisecond-based.
          // Setting it for WebM would write a misleading fixed DefaultDuration.
          output.addVideoTrack(source, choice.codec === 'avc' ? {frameRate: 1000} : {});
          await wait(output.start());
          encoder = new VideoEncoder({
            error: recordFailure,
            output(chunk, metadata) {
              if (!active || failure) return;
              try {
                check();
                const timing = pendingTiming.get(chunk.timestamp);
                if (!timing) throw new Error('视频编码器返回了重复或未知时间戳的帧');
                if (chunk.type !== 'key') throw new Error('视频编码器没有保留请求的关键帧');
                if (!Number.isSafeInteger(chunk.byteLength) || chunk.byteLength <= 0) {
                  throw new Error('视频编码器返回了无效帧数据');
                }
                if (encodedBytes + chunk.byteLength > OUTPUT_LIMIT) throw new Error('视频输出超过 256 MiB 安全上限');
                encodedBytes += chunk.byteLength;
                pendingTiming.delete(chunk.timestamp);
                received++;
                // Some encoders omit chunk.duration. Use original timing even
                // when they supply one, including the final frame's full hold.
                const packet = EncodedPacket.fromEncodedChunk(chunk).clone({
                  timestamp: timing.timestampUs / 1e6,
                  duration: timing.durationUs / 1e6,
                });
                muxPending = Promise.resolve(source.add(packet, metadata));
                muxPending.catch(recordFailure);
              } catch (error) {
                recordFailure(error);
              }
            },
          });
          encoder.configure(choice.config);
          canvas = new OffscreenCanvas(choice.config.width, choice.config.height);
          context = canvas.getContext('2d', {alpha: false});
          if (!context) throw new Error('无法创建视频绘图环境');
        } else if (bitmap.width !== sourceWidth || bitmap.height !== sourceHeight) {
          throw new Error('动图原帧尺寸不一致，无法生成视频');
        }
        if (choice.codec === 'avc' && delayMs > MAX_MP4_DELAY_MS) {
          throw new Error('单帧时长超过 MP4 毫秒时序上限');
        }
        check();
        context.fillStyle = '#000000';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, size.width, size.height);
        const videoFrame = new VideoFrame(canvas, {timestamp: timestampUs, duration: durationUs});
        try {
          pendingTiming.set(timestampUs, {timestampUs, durationUs});
          submitted++;
          encoder.encode(videoFrame, {keyFrame: true});
        } finally {
          videoFrame.close();
        }
        // One input at a time bounds raw image/encoder queues. Quality mode and
        // explicit output accounting prevent successful files with silent drops.
        await wait(encoder.flush());
        await wait(muxPending);
        if (pendingTiming.size || received !== submitted) throw new Error('视频编码器未输出全部原始帧');
        timestampUs += durationUs;
      } finally {
        bitmap.close();
      }
      onProgress?.(submitted);
      check();
      // Deliver cancellation/UI events before asking the source for another frame.
      await wait(new Promise(resolve => setTimeout(resolve, 0)));
    }
    check();
    if (!submitted) throw new Error('动图没有有效帧');
    if (pendingTiming.size || received !== submitted) throw new Error('视频编码器未输出全部原始帧');
    await wait(output.finalize());
    const bytes = new Uint8Array(target.buffer);
    if (bytes.byteLength > OUTPUT_LIMIT) throw new Error('视频输出超过 256 MiB 安全上限');
    if (!bytes.byteLength) throw new Error('视频封装器没有输出有效数据');
    succeeded = true;
    return {bytes, mimeType: choice.codec === 'avc' ? 'video/mp4' : 'video/webm', extension: choice.codec === 'avc' ? 'mp4' : 'webm'};
  } finally {
    active = false;
    if (encoder && encoder.state !== 'closed') encoder.close();
    pendingTiming.clear();
    if (!succeeded && output && output.state !== 'finalized' && output.state !== 'finalizing') {
      await output.cancel().catch(() => {});
    }
    if (canvas) { canvas.width = 1; canvas.height = 1; }
    encoder = output = source = target = canvas = context = null;
  }
}
