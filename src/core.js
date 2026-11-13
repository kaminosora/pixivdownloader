const ID = /^[1-9]\d{0,19}$/;
// Pixiv serves both ID_pN and ID-<32 hex hash>_pN originals. Keep the
// supplied URL intact: the hash is part of the resource identity.
const ORIGINAL_PATH = /^\/img-original\/img\/(?:\d{4}\/)(?:\d{2}\/){5}([1-9]\d*)(?:-[a-f0-9]{32})?_(p|ugoira)(\d+)\.(jpg|jpeg|png|gif|webp|avif)$/;

export function artworkIdFromUrl(value) {
  if (typeof value !== 'string' || value.includes('\\')) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.pixiv.net' || url.port || url.username || url.password) return null;
    const match = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?artworks\/([1-9]\d{0,19})\/?$/.exec(url.pathname);
    return match ? match[1] : null;
  } catch { return null; }
}

export function selectWorks(tabs, windowId, tabId = null) {
  const seen = new Set();
  return tabs.filter((tab) => tab.windowId === windowId && (tabId === null || tab.id === tabId))
    .sort((a, b) => a.index - b.index)
    .flatMap((tab) => {
      const id = artworkIdFromUrl(tab.url);
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [{ id, tabId: tab.id, windowId, url: tab.url }];
    });
}

async function fetchBody(id, suffix, fetchImpl) {
  const signal = AbortSignal.timeout(30_000);
  let response;
  try {
    response = await fetchImpl(`https://www.pixiv.net/ajax/illust/${id}${suffix}`, {
      credentials: 'include', redirect: 'error', signal,
    });
  } catch (error) {
    if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('Pixiv 接口请求超时，请重试');
    throw new Error(`Pixiv 接口网络请求失败：${error?.message || '未知错误'}`);
  }
  if (!response.ok) throw new Error(`Pixiv 接口 HTTP ${response.status}，请检查登录、作品访问权限或网络限制`);
  let data;
  try { data = await response.json(); }
  catch (error) {
    if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('Pixiv 接口响应超时，请重试');
    throw new Error('Pixiv 接口返回无效 JSON，可能需要登录或遇到访问限制');
  }
  if (!data || data.error !== false || data.body == null) throw new Error(`Pixiv 接口失败：${String(data?.message || '响应格式发生变化').slice(0, 300)}`);
  return data.body;
}

function originalInfo(value, id, kind, index) {
  let url;
  try { url = new URL(value); } catch { throw new Error('作品原图 URL 无效'); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || url.hostname !== 'i.pximg.net' || url.port || url.username || url.password || url.search || url.hash || value.includes('\\')) throw new Error('作品原图 CDN 地址不受支持');
  const match = ORIGINAL_PATH.exec(url.pathname);
  if (!match || match[1] !== id || match[2] !== kind || match[3] !== String(index)) throw new Error('作品原图路径、ID 或页码不一致，无法保证原图');
  return { url: url.href, filename: url.pathname.slice(url.pathname.lastIndexOf('/') + 1), extension: match[4] };
}

export async function loadArtwork(id, fetchImpl = fetch) {
  id = String(id);
  if (!ID.test(id)) throw new Error('作品 ID 无效');
  const detail = await fetchBody(id, '', fetchImpl);
  if (String(detail.id) !== id) throw new Error('作品详情 ID 不一致');
  if (!ID.test(String(detail.userId))) throw new Error('作品作者 ID 无效');
  if (typeof detail.title !== 'string' || typeof detail.userName !== 'string') throw new Error('作品详情缺少标题或作者信息');
  if (!Number.isInteger(detail.pageCount) || detail.pageCount < 1) throw new Error('作品页数无效');
  if (![0, 1, 2].includes(detail.illustType)) throw new Error('不支持的作品类型');
  const plan = {
    id, title: detail.title, userName: detail.userName, userId: String(detail.userId),
    kind: detail.illustType === 2 ? 'ugoira' : 'static',
    images: [], frames: [],
  };
  if (plan.kind === 'static') {
    const pages = await fetchBody(id, '/pages', fetchImpl);
    if (!Array.isArray(pages) || pages.length !== detail.pageCount) throw new Error('作品原图页数与详情不一致');
    plan.images = pages.map((page, index) => {
      const info = originalInfo(page?.urls?.original, id, 'p', index);
      return { url: info.url, filename: info.filename };
    });
  } else {
    if (detail.pageCount !== 1) throw new Error('动图作品页数异常');
    const original = originalInfo(detail.urls?.original, id, 'ugoira', 0);
    plan.gifFilename = original.filename.replace(/_ugoira0\.[^.]+$/, '_ugoira.gif');
    const meta = await fetchBody(id, '/ugoira_meta', fetchImpl);
    if (!Array.isArray(meta.frames) || !meta.frames.length) throw new Error('动图缺少原帧时序');
    const names = new Set();
    plan.frames = meta.frames.map((frame, index) => {
      if (!frame || typeof frame.file !== 'string' || !/^\d+\.(jpg|jpeg|png|gif|webp|avif)$/.test(frame.file) || names.has(frame.file)) throw new Error('动图原帧文件名无效或重复');
      if (Number(frame.file.split('.')[0]) !== index) throw new Error('动图原帧编号与时序顺序不一致');
      if (!Number.isSafeInteger(frame.delay) || frame.delay <= 0) throw new Error('动图帧时序无效');
      names.add(frame.file);
      const url = original.url.replace(`_ugoira0.${original.extension}`, `_ugoira${index}.${original.extension}`);
      // Playback metadata can describe recompressed JPEGs; name the bytes by the original format.
      const file = frame.file.replace(/\.[^.]+$/, `.${original.extension}`);
      return { url, file, delay: frame.delay };
    });
  }
  return plan;
}
