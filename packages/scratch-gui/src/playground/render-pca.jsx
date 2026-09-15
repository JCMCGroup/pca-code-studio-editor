// PCA patch: mounts the editor for a PCA Code Studio page. See pca.jsx.

import {EditorState, createStandaloneRoot, setAppElement} from '../index-standalone';
import PcaEditorHOC from '../lib/pca/pca-editor-hoc.jsx';
import {PcaStorage} from '../lib/pca/pca-storage';
import {setColorMode} from '../reducers/settings';
import {detectColorMode} from '../lib/settings/color-mode/persistence';
import pcaLibraryPacks from '../lib/pca/library-packs';

/**
 * @param {HTMLElement} appTarget the element to render into.
 * @param {object} config the page config.
 */
export default (appTarget, config) => {
    setAppElement(appTarget);

    const storage = new PcaStorage(config);
    const isPlayerOnly = config.mode === 'player';
    const state = new EditorState({isPlayerOnly}, () => ({storage}));
    storage.getState = () => state.store.getState();
    // The settings reducer read the colour mode before the page config was set.
    state.dispatch(setColorMode(detectColorMode()));

    const canSave = config.mode === 'edit' && config.permissions.canSave;
    const gui = createStandaloneRoot(state, appTarget, {
        wrappers: isPlayerOnly ? [] : [PcaEditorHOC]
    });

    gui.render({
        projectId: config.project.id,
        projectTitle: config.project.title,
        // Never used by PcaStorage; set so nothing falls back to upstream's hosts.
        projectHost: '',
        assetHost: '',
        canSave,
        canCreateNew: canSave,
        canCreateCopy: canSave,
        canEditTitle: canSave,
        canManageFiles: canSave,
        canRemix: false,
        canShare: false,
        canUseCloud: false,
        canChangeLanguage: true,
        canChangeColorMode: true,
        canChangeTheme: false,
        enableCommunity: false,
        showComingSoon: false,
        backpackVisible: false,
        hideTutorialProjects: true,
        // Our art packs, merged into the sprite, costume and backdrop libraries.
        dynamicAssets: pcaLibraryPacks,
        isPlayerOnly,
        // PcaEditorHOC debounces autosave to 30 seconds after the last change;
        // upstream's own timer (from the first change) is pushed out of the way.
        autoSaveIntervalSecs: 3600,
        accountMenuOptions: {canHaveSession: false}
    });
};
