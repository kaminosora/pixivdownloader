import test from 'node:test';
import assert from 'node:assert/strict';
import { artworkIdFromUrl, selectWorks, loadArtwork } from '../src/core.js';

const base = 'https://i.pximg.net/img-original/img/2026/10/29/01/02/03/';
const original = (suffix) => `${base}123_${suffix}`;
const detail = (extra = {}) => ({ id: '123', title: '标题/作品', userName: '作者', userId: '456', illustType: 1, pageCount: 2, urls: { original: original('p0.jpg') }, ...extra });
function api(artwork = detail(), pages = [{ urls: { original: original('p0.jpg') } }, { urls: { original: original('p1.png') } }], meta) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const body = url.endsWith('/pages') ? pages : url.endsWith('/ugoira_meta') ? meta : artwork;
    return { ok: true, status: 200, json: async () => ({ error: false, body }) };
  };
  fetcher.calls = calls;
  return fetcher;
}

test('artwork URLs accept canonical and language paths only', () => {
  assert.equal(artworkIdFromUrl('https://www.pixiv.net/artworks/123'), '123');
  assert.equal(artworkIdFromUrl('https://www.pixiv.net/en/artworks/123?foo=1#x'), '123');
  assert.equal(artworkIdFromUrl('https://www.pixiv.net/zh-tw/artworks/123/'), '123');
  for (const url of ['http://www.pixiv.net/artworks/123', 'https://pixiv.net/artworks/123', 'https://www.pixiv.net.evil.test/artworks/123', 'https://x@www.pixiv.net/artworks/123', 'https://www.pixiv.net:444/artworks/123', 'https://www.pixiv.net/artworks/0123', 'https://www.pixiv.net/artworks/0', 'https://www.pixiv.net/artworks/123/a', 'https://www.pixiv.net/user/artworks/123', 'https://www.pixiv.net/en/artworks/1e3', 'file:///artworks/123', null]) assert.equal(artworkIdFromUrl(url), null, String(url));
});

test('selection is a sorted, deduplicated snapshot of only the requesting window', () => {
  const url = (id) => `https://www.pixiv.net/artworks/${id}`;
  const tabs = [ { id: 10, windowId: 1, index: 4, url: url(123) }, { id: 11, windowId: 2, index: 0, url: url(222) }, { id: 12, windowId: 1, index: 1, url: url(333) }, { id: 13, windowId: 1, index: 2, url: url(123) }, { id: 14, windowId: 1, index: 0, url: 'https://www.pixiv.net/' } ];
  assert.deepEqual(selectWorks(tabs, 1), [{ id: '333', tabId: 12, windowId: 1, url: url(333) }, { id: '123', tabId: 13, windowId: 1, url: url(123) }]);
  assert.deepEqual(selectWorks(tabs, 1, 10), [{ id: '123', tabId: 10, windowId: 1, url: url(123) }]);
  assert.deepEqual(selectWorks(tabs, 1, 11), []);
  assert.equal(tabs[0].id, 10);
});

test('static metadata plan preserves old-format original basenames and credentials', async () => {
  const fetcher = api();
  const plan = await loadArtwork('123', fetcher);
  assert.deepEqual(plan, { id: '123', title: '标题/作品', userName: '作者', userId: '456', kind: 'static', images: [{ url: original('p0.jpg'), filename: '123_p0.jpg' }, { url: original('p1.png'), filename: '123_p1.png' }], frames: [] });
  assert.deepEqual(fetcher.calls.map((c) => c.url), ['https://www.pixiv.net/ajax/illust/123', 'https://www.pixiv.net/ajax/illust/123/pages']);
  for (const {options} of fetcher.calls) {
    assert.equal(options.credentials, 'include');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
  }
});

// Public upstream fixture: gallery-dl/test/results/pixiv.py, artwork 141762848.
test('static original filenames retain the exact source basename including content hash', async () => {
  const url = 'https://i.pximg.net/img-original/img/2026/03/01/07/35/25/141762848-757d4d64b92a41c496c04aa34ae56855_p0.jpg';
  const fetcher = api(detail({id:'141762848',pageCount:1}), [{urls:{original:url}}]);
  const plan = await loadArtwork('141762848', fetcher);
  assert.deepEqual(plan.images, [{url,filename:'141762848-757d4d64b92a41c496c04aa34ae56855_p0.jpg'}]);
});

test('hashed multi-page originals preserve each exact basename and extension', async () => {
  const urls = [original('p0.jpg').replace('123_', '123-757d4d64b92a41c496c04aa34ae56855_'), original('p1.png').replace('123_', '123-0123456789abcdef0123456789abcdef_')];
  const plan = await loadArtwork('123', api(detail(), urls.map(url=>({urls:{original:url}}))));
  assert.deepEqual(plan.images, [{url:urls[0],filename:'123-757d4d64b92a41c496c04aa34ae56855_p0.jpg'}, {url:urls[1],filename:'123-0123456789abcdef0123456789abcdef_p1.png'}]);
});

test('hash compatibility still rejects other works, wrong pages, malformed hashes and thumbnails', async () => {
  const url=original('p0.jpg').replace('123_', '123-757d4d64b92a41c496c04aa34ae56855_');
  for(const invalid of [url.replace('123-','999-'),url.replace('_p0','_p1'),url.replace('757d4d64b92a41c496c04aa34ae56855','bad'),url.replace('757d4d64b92a41c496c04aa34ae56855','g'.repeat(32)),url.replace('img-original','img-master'),url.replace('_p0.jpg','_p0_master1200.jpg')]) {
    await assert.rejects(loadArtwork('123',api(detail({pageCount:1}),[{urls:{original:invalid}}])),/原图|页码/);
  }
});

test('static originals reject mismatched identity, count, order, thumb and CDN boundaries', async () => {
  const bad = ['https://evil.test/123_p0.jpg', original('p0.jpg').replace('https:', 'http:'), original('p0.jpg').replace('i.pximg.net', 'i.pximg.net.evil.test'), original('p0.jpg').replace('img-original', 'img-master'), original('p0.jpg').replace('123_p0', '999_p0'), original('p1.jpg'), original('p0.jpg') + '?x=1', original('p0.jpg').replace('i.pximg.net', 'u@i.pximg.net')];
  for (const url of bad) await assert.rejects(loadArtwork('123', api(detail({pageCount: 1}), [{ urls: { original: url } }])), /原图|CDN|页|作品/);
  await assert.rejects(loadArtwork('123', api(detail({ id: '999' }))), /ID|作品/);
  await assert.rejects(loadArtwork('123', api(detail({pageCount: 3}))), /页/);
  await assert.rejects(loadArtwork('../123', api()), /ID/);
  await assert.rejects(loadArtwork('123', api(detail({userId: '../456'}))), /作者|用户|ID/);
});

test('ugoira derives original frames from detail original with exact metadata order and millisecond delay', async () => {
  const fetcher = api(detail({illustType: 2, pageCount: 1, urls: {original: original('ugoira0.png')}}), undefined, {originalSrc: 'https://i.pximg.net/img-zip-ugoira/low-quality.zip', frames: [{file: '000000.png', delay: 60}, {file: '000001.png', delay: 125}]});
  const plan = await loadArtwork('123', fetcher);
  assert.equal(plan.kind, 'ugoira');
  assert.equal(plan.gifFilename, '123_ugoira.gif');
  assert.equal(plan.directory, undefined);
  assert.deepEqual(plan.images, []);
  assert.deepEqual(plan.frames, [{url: original('ugoira0.png'), file: '000000.png', delay: 60}, {url: original('ugoira1.png'), file: '000001.png', delay: 125}]);
  assert.equal(fetcher.calls.length, 2);
  assert.match(fetcher.calls[1].url, /\/ugoira_meta$/);
});

test('ugoira conversion filename retains the original content hash and recognizable stem', async () => {
  const url = `${base}123-757d4d64b92a41c496c04aa34ae56855_ugoira0.png`;
  const plan = await loadArtwork('123', api(detail({illustType: 2, pageCount: 1, urls: {original: url}}), undefined, {frames: [{file: '000000.jpg', delay: 80}, {file: '000001.jpg', delay: 120}]}));
  assert.equal(plan.gifFilename, '123-757d4d64b92a41c496c04aa34ae56855_ugoira.gif');
  assert.deepEqual(plan.frames, [
    {url, file: '000000.png', delay: 80},
    {url: `${base}123-757d4d64b92a41c496c04aa34ae56855_ugoira1.png`, file: '000001.png', delay: 120},
  ]);
});

test('ugoira never substitutes playback ZIP or accepts malformed original frames', async () => {
  const good = { frames: [{file: '000000.jpg', delay: 60}] };
  const art = detail({illustType: 2, pageCount: 1, urls: {original: original('ugoira0.jpg')}});
  for (const frames of [[], [{file: '../0.jpg', delay: 60}], [{file: '000000.jpg', delay: 0}], [{file: '000000.jpg', delay: -1}], [{file: '000000.jpg', delay: '60'}], [{file: '000000.jpg', delay: 1.5}], [{file: '000000.jpg', delay: 60}, {file: '000000.jpg', delay: 60}]]) await assert.rejects(loadArtwork('123', api(art, undefined, { frames })), /帧|时序/);
  await assert.rejects(loadArtwork('123', api({...art, urls: {original: 'https://i.pximg.net/img-zip-ugoira/123.zip'}}, undefined, {...good, originalSrc: 'https://i.pximg.net/a.zip'})), /原图|原帧/);
});

test('original frame metadata keeps the image extension when playback differs', async () => {
  const plan = await loadArtwork('123', api(detail({illustType: 2, pageCount: 1, urls: {original: original('ugoira0.png')}}), undefined, {frames: [{file: '000000.jpg', delay: 80}]}));
  assert.equal(plan.frames[0].file, '000000.png');
  assert.equal(plan.frames[0].url, original('ugoira0.png'));
});

test('out of order metadata frame numbers cannot silently select different original frames', async () => {
  await assert.rejects(loadArtwork('123', api(detail({illustType: 2, pageCount: 1, urls: {original: original('ugoira0.jpg')}}), undefined, {frames: [{file: '000001.jpg', delay: 80}]})), /帧|时序/);
});

test('API and HTTP failures produce actionable failure instead of fallback', async () => {
  await assert.rejects(loadArtwork('123', async () => ({ok: false, status: 403})), /403/);
  await assert.rejects(loadArtwork('123', async () => ({ok: true, json: async () => ({error: true, message: '请登录'})})), /请登录/);
  await assert.rejects(loadArtwork('123', async () => ({ok: true, json: async () => {throw new Error('bad json');}})), /JSON|接口/);
  await assert.rejects(loadArtwork('123', async () => {throw new DOMException('timed out', 'TimeoutError');}), /超时/);
  await assert.rejects(loadArtwork('123', api(detail({illustType: 99}))), /类型/);
});
