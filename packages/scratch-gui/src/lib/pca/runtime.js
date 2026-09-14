// PCA patch: the page configuration the PCA entry point (playground/pca.jsx)
// reads from the host page, made available to the few upstream components
// that change their behaviour in a PCA build.
//
// Every upstream patch that reads this checks `getPcaRuntime()` first and
// behaves exactly as upstream when it is null, so the upstream playground
// builds are unchanged.
//
// The config is data from the host page (a <script type="application/json">
// block), never code. Its shape is documented in PCA_PATCHES.md.

let runtime = null;
let hooks = {};

/**
 * Callbacks the PCA editor wrapper registers for upstream components to use
 * instead of their own behaviour: `saveToComputer()`, `beginImport()`,
 * `importProject(title)` and `importFailed(message)`.
 * @param {object} newHooks the callbacks, or an empty object to clear them.
 */
export const setPcaHooks = newHooks => {
    hooks = newHooks || {};
};

/**
 * @returns {object} the registered callbacks (empty outside a PCA editor page).
 */
export const getPcaHooks = () => hooks;

/**
 * @param {object|null} config the parsed page config, or null to clear it.
 */
export const setPcaRuntime = config => {
    runtime = config;
};

/**
 * @returns {object|null} the page config when running as PCA Code Studio.
 */
export const getPcaRuntime = () => runtime;

/**
 * @returns {boolean} whether the sprite, costume, backdrop and sound library
 *   may be offered. Always true outside a PCA build.
 */
export const pcaLibraryEnabled = () => {
    if (!runtime) return true;
    const library = runtime.features && runtime.features.library;
    return Boolean(library && library.source !== 'off');
};

/**
 * @returns {boolean} whether sounds may be recorded with the microphone.
 *   Always true outside a PCA build.
 */
export const pcaSoundRecordingEnabled = () => {
    if (!runtime) return true;
    return Boolean(runtime.features && runtime.features.soundRecording);
};

// The Scratch Foundation's trademarked characters (see TRADEMARK): a name that
// starts with one and then anything but a letter, so "Cat-a", "Cat 2" and
// "Pico Walk1" match and "Catcher" does not.
const TRADEMARKED_NAME = /^(cat|gobo|pico|nano|tera|giga)(?![a-z])/i;

/**
 * Leaves the trademarked characters out of the sprite, costume, backdrop and
 * sound library lists, and so out of Surprise. Only the lists change: a
 * project that already uses one of these costumes, or an .sb3 loaded from the
 * computer that contains one, still loads, plays and saves as before.
 * @param {Array.<object>} items library entries, each with a `name`.
 * @returns {Array.<object>} the entries this page may offer; the same array
 *   outside a PCA build.
 */
export const pcaFilterLibrary = items => {
    if (!runtime) return items;
    return items.filter(item => !TRADEMARKED_NAME.test(item.name || ''));
};

/**
 * @param {Array.<object>} extensions the extension library entries.
 * @returns {Array.<object>} the entries this page may offer: in a PCA build
 *   only the configured official extensions, in the configured order.
 */
export const pcaFilterExtensions = extensions => {
    if (!runtime) return extensions;
    const allowed = (runtime.features && runtime.features.extensions) || [];
    return allowed
        .map(id => extensions.find(extension => extension.extensionId === id))
        .filter(Boolean);
};
