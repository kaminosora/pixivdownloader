const DATABASE = 'pixiv-direct-files';
const STORE = 'directories';

function assertDirectory(handle) {
  if (handle?.kind !== 'directory') throw new TypeError('请选择有效的保存目录');
}

function assertId(id) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('保存目录 ID 无效');
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('保存目录数据库被占用，请关闭旧的目录选择页后重试')); };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function directoryRecord(id, mode, handle) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      const request = mode === 'readwrite' ? store.put(handle, id) : store.get(id);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error || request.error || new Error('保存目录数据库操作失败'));
    });
  } finally {
    database.close();
  }
}

export async function putDirectory(id, handle) {
  assertId(id);
  assertDirectory(handle);
  await directoryRecord(id, 'readwrite', handle);
}

export async function getDirectory(id) {
  assertId(id);
  const handle = await directoryRecord(id, 'readonly');
  if (handle !== undefined) assertDirectory(handle);
  return handle;
}

export async function hasWritePermission(handle) {
  if (handle?.kind !== 'directory') return false;
  try { return await handle.queryPermission({ mode: 'readwrite' }) === 'granted'; }
  catch { return false; }
}

function assertBasename(filename) {
  if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..' ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(filename) || /[. ]$/.test(filename) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) {
    throw new TypeError('原图文件名无效：只能保存安全的文件名，不能包含路径');
  }
}

function numberedName(filename, number) {
  if (!number) return filename;
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? `${filename.slice(0, dot)} (${number})${filename.slice(dot)}` : `${filename} (${number})`;
}

// The offscreen queue has one writer. File System Access has no exclusive-create
// primitive, so a filename probe and creation must stay in this serial writer.
async function createUnusedFile(directory, filename, signal) {
  for (let number = 0; ; number++) {
    signal?.throwIfAborted();
    const name = numberedName(filename, number);
    try {
      await directory.getFileHandle(name);
      continue;
    } catch (error) {
      if (error.name === 'TypeMismatchError') continue; // Existing directory.
      if (error.name !== 'NotFoundError') throw error;
    }
    signal?.throwIfAborted();
    try { return { name, file: await directory.getFileHandle(name, { create: true }) }; }
    catch (error) {
      if (error.name !== 'TypeMismatchError') throw error;
    }
  }
}

async function removeUnchangedEmptyFile(directory, name, file, initialFile) {
  if (initialFile?.size !== 0 || !Number.isFinite(initialFile.lastModified)) return;
  try {
    const current = await directory.getFileHandle(name);
    if (!await file.isSameEntry(current)) return;
    const snapshot = await current.getFile();
    // isSameEntry compares locators, so a replacement at this path can still
    // match. Uncommitted createWritable data lives in a temporary file: only
    // remove a still-empty placeholder whose modification metadata is unchanged.
    if (snapshot.size === 0 && snapshot.lastModified === initialFile.lastModified) await directory.removeEntry(name);
  } catch {
    // Uncertain metadata or revoked permissions leave a possible residue and
    // must not mask the original failure or trigger recursive deletion.
  }
}

export async function writeOriginalFile(handle, filename, blob, signal) {
  assertDirectory(handle);
  assertBasename(filename);
  signal?.throwIfAborted();
  if (!await hasWritePermission(handle)) throw new DOMException('保存目录权限已失效，请重新选择保存位置', 'NotAllowedError');
  signal?.throwIfAborted();

  const { name, file } = await createUnusedFile(handle, filename, signal);
  let writer;
  let initialFile;
  let committed = false;
  let abortPromise;
  const abort = reason => {
    if (writer && !abortPromise) abortPromise = writer.abort(reason).catch(() => {});
    return abortPromise;
  };
  const onAbort = () => { void abort(signal.reason); };
  try {
    initialFile = await file.getFile();
    if (initialFile.size !== 0) throw new DOMException('保存目标已被其他程序修改，请重试', 'InvalidModificationError');
    signal?.throwIfAborted();
    const writable = await file.createWritable();
    writer = writable.getWriter();
    signal?.addEventListener('abort', onAbort, { once: true });
    signal?.throwIfAborted();
    await writer.write(blob);
    signal?.throwIfAborted();
    await writer.close();
    committed = true;
    // Once close succeeds, cancellation must not erase or misreport this file.
    return name;
  } catch (error) {
    await abort(error);
    if (!committed) await removeUnchangedEmptyFile(handle, name, file, initialFile);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    writer?.releaseLock();
  }
}
