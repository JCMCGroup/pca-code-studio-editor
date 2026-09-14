// PCA patch: the GUIStorage the PCA build hands the editor instead of
// LegacyStorage. Projects and costumes/sounds are loaded from and saved to the
// host portal's API (see api.js); nothing is fetched from anywhere else.
//
// Saves go through upstream's ProjectSaverHOC unchanged: it uploads assets that
// are not yet clean with `scratchStorage.store`, then calls `saveProject`. Both
// arrive here. Every failure is reported to listeners (the PCA editor wrapper)
// with enough detail to tell the child what happened, then rethrown so upstream
// keeps the project marked as changed.

import {ScratchStorage} from '@scratch/scratch-storage';

import defaultProject from '../default-project';
import {PcaApi, PcaApiError} from './api';

/** Autosave-sized saves do not need a new thumbnail every time. */
const THUMBNAIL_MIN_INTERVAL_MS = 2 * 60 * 1000;

const ASSET_FORMATS = ['svg', 'png', 'jpg', 'wav', 'mp3'];

export class PcaStorage {
    /**
     * @param {object} config the whole page config.
     */
    constructor (config) {
        this.config = config;
        this.api = new PcaApi(config.api);
        this.version = config.project.version;
        this.listeners = new Set();
        this.lastThumbnailAt = 0;
        this.translator = null;
        /** True while a file from the computer is becoming a new project. */
        this.importing = false;
        /** Set by the entry point: reads the redux store. */
        this.getState = () => null;

        this.scratchStorage = new ScratchStorage();
        this.cacheDefaultProject();
        this.addWebStores();
        this.wrapLoadAndStore();
    }

    // -- events for the editor wrapper -----------------------------------
    subscribe (listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit (event) {
        this.listeners.forEach(listener => listener(event));
    }

    // -- GUIStorage ------------------------------------------------------
    setProjectHost () {}
    setProjectToken () {}
    setAssetHost () {}
    setBackpackHost () {}

    setProjectMetadata (projectId) {
        const {RequestMetadata, setMetadata, unsetMetadata} = this.scratchStorage.scratchFetch;
        if (projectId && projectId !== '0') {
            setMetadata(RequestMetadata.ProjectId, projectId);
        } else {
            unsetMetadata(RequestMetadata.ProjectId);
        }
    }

    setTranslatorFunction (translator) {
        this.translator = translator;
        this.cacheDefaultProject();
    }

    getLibraryAssetUrl (assetId, dataFormat) {
        const library = this.config.features.library;
        if (library.source === 'local') return `${library.assetBase}${assetId}.${dataFormat}`;
        if (library.source === 'upstream') return `${library.assetBase}${assetId}.${dataFormat}/get/`;
        return '';
    }

    /**
     * Save the project over the version this page loaded, or create a copy.
     * @param {string|null} projectId the project, or null to create one.
     * @param {string} vmState project.json from the VM.
     * @param {object} params upstream's copy/remix parameters.
     * @returns {Promise<{id: string}>} the saved (or new) project's id.
     */
    async saveProject (projectId, vmState, params = {}) {
        if (this.importing) {
            // The editor holds a file being imported, not this project.
            throw new Error('A file is being added as a new project.');
        }
        try {
            if (projectId === null || typeof projectId === 'undefined' || params.isCopy) {
                const title = params.title ? `Copy of ${params.title}` : '';
                const created = await this.withMissingAssets(vmState, () => this.api.createProject(vmState, title));
                this.emit({type: 'copied', id: created.public_id});
                return {id: created.public_id};
            }
            const autosave = this.isAutosave();
            const saved = await this.withMissingAssets(
                vmState, () => this.api.saveProject(vmState, this.version, autosave)
            );
            this.version = saved.version;
            this.emit({type: 'saved', version: saved.version});
            return {id: projectId};
        } catch (error) {
            this.emit({type: 'error', error: this.describe(error, vmState)});
            throw error;
        }
    }

    /**
     * Turn the project now in the VM (a file just loaded from the computer) into
     * a new project: upload every costume and sound it uses, then create it.
     * @param {string} title the new project's title.
     * @returns {Promise<string>} the new project's public id.
     */
    async importAsNewProject (title) {
        const vm = this.getState().scratchGui.vm;
        const vmState = vm.toJSON();
        try {
            const project = JSON.parse(vmState);
            const wanted = new Set();
            for (const target of project.targets || []) {
                for (const item of [...(target.costumes || []), ...(target.sounds || [])]) {
                    wanted.add(item.md5ext || `${item.assetId}.${item.dataFormat}`);
                }
            }
            for (const md5ext of wanted) {
                const [assetId, dataFormat] = md5ext.split('.');
                const asset = vm.assets.find(a => a.assetId === assetId && a.dataFormat === dataFormat);
                if (asset && asset.data) {
                    await this.uploadAsset(asset.assetId, asset.dataFormat, asset.data, vmState);
                }
            }
            const created = await this.api.createProject(vmState, title);
            return created.public_id;
        } catch (error) {
            error.described = this.describe(error, vmState);
            throw error;
        }
    }

    saveProjectThumbnail (projectId, thumbnail, onSuccess, onError) {
        const now = Date.now();
        if (projectId !== this.config.project.id || now - this.lastThumbnailAt < THUMBNAIL_MIN_INTERVAL_MS) {
            return;
        }
        this.lastThumbnailAt = now;
        this.api.saveThumbnail(thumbnail).then(onSuccess, onError);
    }

    // -- internals -------------------------------------------------------
    isAutosave () {
        const state = this.getState();
        const loadingState = state && state.scratchGui.projectState.loadingState;
        return loadingState !== 'MANUAL_UPDATING';
    }

    /**
     * Run a save; if the portal says some costumes or sounds are not there yet
     * (for example ones picked from the media library in development), upload
     * them from the VM and try once more.
     * @param {string} vmState project.json being saved.
     * @param {function} attempt performs the request.
     * @returns {Promise<object>} the response body.
     */
    async withMissingAssets (vmState, attempt) {
        try {
            return await attempt();
        } catch (error) {
            const missing = error instanceof PcaApiError && error.code === 'missing_assets' ?
                error.body.missing_assets || [] : [];
            if (!missing.length) throw error;
            const vm = this.getState() && this.getState().scratchGui.vm;
            const assets = vm ? vm.assets : [];
            for (const md5ext of missing) {
                const [assetId, dataFormat] = md5ext.split('.');
                const asset = assets.find(a => a.assetId === assetId && a.dataFormat === dataFormat);
                if (!asset || !asset.data) throw error;
                await this.uploadAsset(asset.assetId, asset.dataFormat, asset.data, vmState);
            }
            return attempt();
        }
    }

    async uploadAsset (assetId, dataFormat, data, vmState) {
        const md5ext = `${assetId}.${dataFormat}`;
        try {
            await this.api.uploadAsset(md5ext, data);
        } catch (error) {
            error.md5ext = md5ext;
            if (!vmState) this.emit({type: 'error', error: this.describe(error, null)});
            throw error;
        }
    }

    /**
     * Turn an error into what the editor wrapper shows a child.
     * @param {Error} error the failure.
     * @param {string|null} vmState the project being saved, to name costumes.
     * @returns {object} kind, message and details.
     */
    describe (error, vmState) {
        if (!(error instanceof PcaApiError)) {
            return {kind: 'offline', message: 'Not saved – check your connection'};
        }
        if (error.isOffline) return {kind: 'offline', message: 'Not saved – check your connection'};
        if (error.isSignedOut) return {kind: 'signedOut', message: error.message};
        if (error.isConflict) {
            return {kind: 'conflict', message: error.message, currentVersion: error.body.current_version};
        }
        if (error.code === 'quota' || error.code === 'too_many_projects') {
            return {kind: 'quota', message: error.message};
        }
        if (error.md5ext) {
            const name = this.assetName(error.md5ext, vmState);
            return {
                kind: 'asset',
                md5ext: error.md5ext,
                message: name ?
                    `“${name}” can’t be saved. ${error.message}` :
                    `A costume or sound can’t be saved. ${error.message}`
            };
        }
        if (error.status === 413) return {kind: 'tooBig', message: error.message};
        return {kind: 'error', message: error.message};
    }

    assetName (md5ext, vmState) {
        let project;
        try {
            const vm = this.getState() && this.getState().scratchGui.vm;
            project = JSON.parse(vmState || (vm ? vm.toJSON() : '{}'));
        } catch {
            return null;
        }
        for (const target of project.targets || []) {
            for (const item of [...(target.costumes || []), ...(target.sounds || [])]) {
                if (item.md5ext === md5ext || `${item.assetId}.${item.dataFormat}` === md5ext) {
                    return target.isStage ? item.name : `${item.name} (${target.name})`;
                }
            }
        }
        return null;
    }

    cacheDefaultProject () {
        const storage = this.scratchStorage;
        defaultProject(this.translator).forEach(asset => storage.builtinHelper._store(
            storage.AssetType[asset.assetType],
            storage.DataFormat[asset.dataFormat],
            asset.data,
            asset.id
        ));
    }

    addWebStores () {
        const storage = this.scratchStorage;
        const {AssetType} = storage;
        const media = [AssetType.ImageVector, AssetType.ImageBitmap, AssetType.Sound];
        storage.addWebStore(media, asset => (
            ASSET_FORMATS.includes(asset.dataFormat) ?
                `${this.config.api.assets}${asset.assetId}.${asset.dataFormat}` :
                null
        ));
        if (this.config.features.library.source === 'upstream') {
            // Development only: fall back to the media library on its original host.
            storage.addWebStore(media, asset => this.getLibraryAssetUrl(asset.assetId, asset.dataFormat));
        }
        // The music extension's instrument samples ship with the editor build.
        storage.addWebStore(
            [AssetType.Sound],
            asset => `static/extension-assets/scratch3_music/${asset.assetId}.${asset.dataFormat}`
        );
    }

    /**
     * Projects are loaded and costumes/sounds are stored through our API
     * directly, so the version header and error bodies are not lost inside
     * scratch-storage's fetch tools.
     */
    wrapLoadAndStore () {
        const storage = this.scratchStorage;
        const load = storage.load.bind(storage);
        const store = storage.store.bind(storage);

        storage.load = (assetType, assetId, dataFormat) => {
            if (assetType !== storage.AssetType.Project) return load(assetType, assetId, dataFormat);
            if (String(assetId) !== String(this.config.project.id)) return load(assetType, assetId, dataFormat);
            return this.api.loadProject().then(({data, version}) => {
                if (Number.isInteger(version)) this.version = version;
                return storage.createAsset(
                    storage.AssetType.Project, storage.DataFormat.JSON, data, assetId, false
                );
            }, error => {
                this.emit({type: 'loadError', error: this.describe(error, null), cause: error});
                throw error;
            });
        };

        storage.store = (assetType, dataFormat, data, assetId) => {
            if (assetType === storage.AssetType.Project || !assetId) {
                return store(assetType, dataFormat, data, assetId);
            }
            return this.uploadAsset(assetId, dataFormat, data, null)
                .then(() => ({status: 'ok', id: assetId}));
        };
    }
}
