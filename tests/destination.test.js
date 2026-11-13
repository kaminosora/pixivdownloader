import test from 'node:test';
import assert from 'node:assert/strict';
import { hasWritePermission, putDirectory, writeOriginalFile } from '../src/destination.js';

function directory({ permission = 'granted', hooks = {} } = {}) {
  const entries = new Map();
  const removed = [];
  const permissionModes = [];
  const handle = {
    kind: 'directory', name: 'chosen', entries, removed, permissionModes,
    async queryPermission(options) { permissionModes.push(options.mode); return permission; },
    async requestPermission() { throw new Error('Background writes must not prompt'); },
    async getFileHandle(name, { create = false } = {}) {
      let entry = entries.get(name);
      if (entry?.kind === 'directory') throw new DOMException('A directory has this name', 'TypeMismatchError');
      if (!entry) {
        if (!create) throw new DOMException('Missing entry', 'NotFoundError');
        entry = { kind: 'file', bytes: new Uint8Array(), lastModified: 1700000000000, aborted: false, committed: false };
        entries.set(name, entry);
      }
      return {
        kind: 'file', name, directory: handle,
        // Native handles identify a directory/name locator, not a stable inode.
        async isSameEntry(other) { return other.directory === handle && other.name === name; },
        async getFile() {
          const current = entries.get(name);
          if (!current) throw new DOMException('Missing entry', 'NotFoundError');
          if (current.kind !== 'file') throw new DOMException('Not a file', 'TypeMismatchError');
          await hooks.stat?.(name, current);
          return new File([current.bytes], name, { lastModified: current.lastModified ?? 1700000000000 });
        },
        async createWritable() {
          await hooks.open?.(name, entry);
          let pending;
          return new WritableStream({
            async write(blob) {
              assert.ok(blob instanceof Blob, 'writes a Blob without converting the original bytes');
              pending = new Uint8Array(await blob.arrayBuffer());
              await hooks.write?.(name, entry);
            },
            async close() {
              await hooks.close?.(name, entry);
              entry.bytes = pending;
              entry.committed = true;
              hooks.committed?.(name, entry);
            },
            abort() { entry.aborted = true; pending = undefined; }
          });
        }
      };
    },
    async removeEntry(name) { removed.push(name); entries.delete(name); }
  };
  return handle;
}

test('writes original bytes and reports the unchanged hashed basename', async () => {
  const target = directory();
  const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10]);
  const filename = '123-0123456789abcdef0123456789abcdef_p0.png';
  assert.equal(await writeOriginalFile(target, filename, new Blob([bytes])), filename);
  assert.deepEqual(target.entries.get(filename).bytes, bytes);
  assert.equal(target.entries.get(filename).committed, true);
  assert.deepEqual(target.removed, []);
});

test('same-name files and directories are preserved while the next numbered name is chosen', async () => {
  const target = directory();
  target.entries.set('123_p0.jpg', { kind: 'file', bytes: new Uint8Array([1, 2]) });
  target.entries.set('123_p0 (1).jpg', { kind: 'directory' });
  target.entries.set('123_p0 (2).jpg', { kind: 'file', bytes: new Uint8Array([3]) });
  assert.equal(await writeOriginalFile(target, '123_p0.jpg', new Blob([new Uint8Array([9])])), '123_p0 (3).jpg');
  assert.deepEqual(target.entries.get('123_p0.jpg').bytes, new Uint8Array([1, 2]));
  assert.deepEqual(target.entries.get('123_p0 (1).jpg'), { kind: 'directory' });
  assert.deepEqual(target.entries.get('123_p0 (2).jpg').bytes, new Uint8Array([3]));
  assert.deepEqual(target.entries.get('123_p0 (3).jpg').bytes, new Uint8Array([9]));
  assert.deepEqual(target.removed, []);
});

test('permission checks never request access and reject missing, denied or unqueryable handles', async () => {
  const granted = directory();
  assert.equal(await hasWritePermission(granted), true);
  assert.deepEqual(granted.permissionModes, ['readwrite']);
  for (const target of [null, { kind: 'file' }, directory({ permission: 'prompt' }), directory({ permission: 'denied' }), { kind: 'directory', async queryPermission() { throw new Error('Revoked'); } }]) {
    assert.equal(await hasWritePermission(target), false);
  }
});

test('denied write permission creates no file', async () => {
  const target = directory({ permission: 'denied' });
  await assert.rejects(writeOriginalFile(target, '123_p0.jpg', new Blob(['original'])), { name: 'NotAllowedError' });
  assert.equal(target.entries.size, 0);
});

test('unsafe basenames and non-directory handles are rejected before accessing the destination', async () => {
  for (const filename of ['', '.', '..', '../123.jpg', 'folder/123.jpg', 'folder\\123.jpg', 'C:123.jpg', 'CON', 'con.jpg', 'COM1.png', 'LPT9.txt', 'nul.gif', 'x?.png', 'x*.png', 'x|.png', 'x<.png', 'x>.png', 'x".png', 'x\u0000.png', 'x\u001f.png', '123.jpg ', '123.jpg.']) {
    const target = directory();
    await assert.rejects(writeOriginalFile(target, filename, new Blob(['original'])), { name: 'TypeError' }, filename);
    assert.equal(target.entries.size, 0, filename);
    assert.deepEqual(target.permissionModes, [], filename);
  }
  await assert.rejects(putDirectory('chosen', { kind: 'file' }), { name: 'TypeError' });
  await assert.rejects(writeOriginalFile({ kind: 'file' }, '123.jpg', new Blob()), { name: 'TypeError' });
});

test('a previously cancelled write does not create a placeholder', async () => {
  const target = directory();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(writeOriginalFile(target, '123.jpg', new Blob(['original']), controller.signal), { name: 'AbortError' });
  assert.equal(target.entries.size, 0);
});

test('cancelling a pending write aborts it and removes only its new placeholder', async () => {
  const controller = new AbortController();
  let pendingEntry;
  const target = directory({ hooks: { write(name, entry) { pendingEntry = entry; controller.abort(); } } });
  target.entries.set('123.jpg', { kind: 'file', bytes: new Uint8Array([7]) });
  await assert.rejects(writeOriginalFile(target, '123.jpg', new Blob(['original']), controller.signal), { name: 'AbortError' });
  assert.equal(pendingEntry.aborted, true);
  assert.deepEqual([...target.entries.keys()], ['123.jpg']);
  assert.deepEqual(target.entries.get('123.jpg').bytes, new Uint8Array([7]));
  assert.deepEqual(target.removed, ['123 (1).jpg']);
});

test('failure opening, writing or closing cleans up only the newly created file', async () => {
  for (const phase of ['open', 'write', 'close']) {
    const target = directory({ hooks: { [phase]() { throw new Error(`failure during ${phase}`); } } });
    target.entries.set('123.jpg', { kind: 'file', bytes: new Uint8Array([7]) });
    await assert.rejects(writeOriginalFile(target, '123.jpg', new Blob(['original'])), new RegExp(`failure during ${phase}`));
    assert.deepEqual([...target.entries.keys()], ['123.jpg']);
    assert.deepEqual(target.entries.get('123.jpg').bytes, new Uint8Array([7]));
    assert.deepEqual(target.removed, ['123 (1).jpg']);
  }
});

test('cancellation racing a successful close retains the complete file and returns its name', async () => {
  const controller = new AbortController();
  const target = directory({ hooks: { committed() { controller.abort(); } } });
  assert.equal(await writeOriginalFile(target, '123.jpg', new Blob(['original']), controller.signal), '123.jpg');
  assert.equal(new TextDecoder().decode(target.entries.get('123.jpg').bytes), 'original');
  assert.deepEqual(target.removed, []);
});

test('cleanup preserves nonempty replacement data even when native locator comparison still matches', async () => {
  const replacement = { kind: 'file', bytes: new Uint8Array([8, 9]) };
  const target = directory({ hooks: { write(name) { target.entries.set(name, replacement); throw new Error('write failed'); } } });
  await assert.rejects(writeOriginalFile(target, '123.jpg', new Blob(['original'])), /write failed/);
  assert.equal(target.entries.get('123.jpg'), replacement);
  assert.deepEqual(target.removed, []);
});

test('cleanup preserves an empty replacement with changed modification metadata', async () => {
  const replacement = { kind: 'file', bytes: new Uint8Array(), lastModified: 1700000001000 };
  const target = directory({ hooks: { write(name) { target.entries.set(name, replacement); throw new Error('write failed'); } } });
  await assert.rejects(writeOriginalFile(target, '123.jpg', new Blob(['original'])), /write failed/);
  assert.equal(target.entries.get('123.jpg'), replacement);
  assert.deepEqual(target.removed, []);
});

test('uncertain cleanup metadata leaves the failed placeholder and preserves the write error', async () => {
  let reads = 0;
  const target = directory({ hooks: {
    stat() { if (++reads > 1) throw new DOMException('Permission revoked', 'NotAllowedError'); },
    write() { throw new Error('original write error'); }
  } });
  await assert.rejects(writeOriginalFile(target, '123.jpg', new Blob(['original'])), /original write error/);
  assert.ok(target.entries.has('123.jpg'), 'uncertain metadata must preserve the entry');
  assert.equal(target.entries.get('123.jpg').bytes.length, 0);
  assert.deepEqual(target.removed, []);
});

test('a newly selected file that already contains external data is never opened for writing', async () => {
  const target = directory({ hooks: { stat(name, entry) { entry.bytes = new Uint8Array([42]); } } });
  await assert.rejects(writeOriginalFile(target, '123.jpg', new Blob(['original'])), { name: 'InvalidModificationError' });
  assert.deepEqual(target.entries.get('123.jpg').bytes, new Uint8Array([42]));
  assert.deepEqual(target.removed, []);
});
