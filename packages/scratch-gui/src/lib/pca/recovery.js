// PCA patch: a local recovery copy of unsaved work, per project, in IndexedDB.
//
// Written a few seconds after changes stop and when the tab is hidden, as a
// whole .sb3 so costumes and sounds that never reached the server are kept too.
// Deleted after a successful save that covers it, and expired after
// RECOVERY_MAX_AGE_MS: club laptops are shared, so nothing is kept longer than
// it is useful.

const DB_NAME = 'pca-code-studio';
const STORE = 'recovery';
export const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const open = () => new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available'));
        return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, {keyPath: 'projectId'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

const run = async (mode, action) => {
    const db = await open();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE, mode);
            const request = action(transaction.objectStore(STORE));
            transaction.oncomplete = () => resolve(request && request.result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    } finally {
        db.close();
    }
};

/**
 * @param {object} record projectId, savedAt, baseVersion, changeCount, sb3 (Blob).
 * @returns {Promise} resolves when written.
 */
export const writeRecovery = record => run('readwrite', store => store.put(record));

/**
 * @param {string} projectId the project's public id.
 * @returns {Promise<object|undefined>} the recovery copy, if any.
 */
export const readRecovery = projectId => run('readonly', store => store.get(projectId));

/**
 * @param {string} projectId the project's public id.
 * @returns {Promise} resolves when removed.
 */
export const deleteRecovery = projectId => run('readwrite', store => store.delete(projectId));

/**
 * Remove every recovery copy older than RECOVERY_MAX_AGE_MS.
 * @returns {Promise} resolves when done.
 */
export const expireRecovery = () => run('readwrite', store => {
    const cutoff = Date.now() - RECOVERY_MAX_AGE_MS;
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (!cursor.value.savedAt || cursor.value.savedAt < cutoff) cursor.delete();
        cursor.continue();
    };
    return cursorRequest;
});
