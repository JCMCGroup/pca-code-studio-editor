/** Host serving library assets when no library asset host is configured. */
const LEGACY_LIBRARY_ASSET_HOST = 'https://cdn.assets.scratch.mit.edu';

/**
 * Build the URL a library asset is fetched from, in the shape Scratch's asset service uses.
 * @param {string} assetId - the md5 of the asset.
 * @param {string} dataFormat - the asset's file extension.
 * @param {string} [host] - the host serving the assets, without a trailing slash.
 *   When omitted or empty, the public Scratch asset service is used.
 * @returns {string} - the URL to fetch the asset from.
 */
export const buildLibraryAssetUrl = (assetId: string, dataFormat: string, host?: string): string => {
    if (!host) {
        return `${LEGACY_LIBRARY_ASSET_HOST}/internalapi/asset/${assetId}.${dataFormat}/get/`;
    }
    return `${host}/internalapi/asset/${assetId}.${dataFormat}/get/`;
};
