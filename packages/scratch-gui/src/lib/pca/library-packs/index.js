// PCA patch: art packs added to the sprite, costume and backdrop libraries on a
// PCA page, handed to the GUI as upstream's `dynamicAssets`.
//
// The JSON files are generated, not edited by hand: the portal's
// `scripts/build_code_library_packs.py` splits each pack's atlases and renders
// its 3D models into single pictures, writes them as <md5>.png for
// `flask code-import-library`, and writes these entries. `packs.json` credits
// each pack (all CC0).

import backdrops from './backdrops.json';
import costumes from './costumes.json';
import packs from './packs.json';
import sprites from './sprites.json';

const pcaLibraryPacks = {sprites, costumes, backdrops, sounds: []};

export {packs as pcaLibraryPackCredits};
export default pcaLibraryPacks;
