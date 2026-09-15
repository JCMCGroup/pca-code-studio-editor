/**
 * @jest-environment jsdom
 */
// PCA patch checks: the page-config runtime the upstream patches read, the API
// client's CSRF refresh, and how failed saves are described to a child.
import mergeDynamicAssets from '../../../src/lib/merge-dynamic-assets';
import spriteLibraryContent from '../../../src/lib/libraries/sprites.json';
import costumeLibraryContent from '../../../src/lib/libraries/costumes.json';
import backdropLibraryContent from '../../../src/lib/libraries/backdrops.json';
import backdropTags from '../../../src/lib/libraries/backdrop-tags';
import spriteTags from '../../../src/lib/libraries/sprite-tags';
import pcaLibraryPacks, {pcaLibraryPackCredits} from '../../../src/lib/pca/library-packs';
import {
    getPcaRuntime,
    pcaFilterExtensions,
    pcaFilterLibrary,
    pcaLibraryEnabled,
    pcaLibraryTags,
    pcaSoundRecordingEnabled,
    setPcaRuntime
} from '../../../src/lib/pca/runtime';
import {PcaApi, PcaApiError} from '../../../src/lib/pca/api';

const response = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {get: name => (name === 'Content-Type' ? 'application/json' : headers[name] || null)},
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(2))
});

describe('PCA runtime', () => {
    afterEach(() => setPcaRuntime(null));

    test('behaves as upstream when there is no page config', () => {
        expect(getPcaRuntime()).toBeNull();
        expect(pcaLibraryEnabled()).toBe(true);
        expect(pcaSoundRecordingEnabled()).toBe(true);
        const all = [{extensionId: 'pen'}, {extensionId: 'videoSensing'}, {name: 'custom'}];
        expect(pcaFilterExtensions(all)).toBe(all);
    });

    test('offers only the configured extensions, in order, and never a custom one', () => {
        setPcaRuntime({features: {extensions: ['music', 'pen', 'nonexistent'], library: {source: 'off'}}});
        const all = [
            {extensionId: 'pen'}, {extensionId: 'music'}, {extensionId: 'videoSensing'}, {name: 'custom URL'}
        ];
        expect(pcaFilterExtensions(all).map(e => e.extensionId)).toEqual(['music', 'pen']);
    });

    test('leaves the trademarked characters out of the library lists on a PCA page only', () => {
        const names = ['Cat', 'Cat-a', 'Cat 2', 'Cat Flying-b', 'Catcher', 'Gobo-c', 'Pico Walk1', 'giga',
            'Nano-a', 'Tera', 'Abby', 'Meow'];
        const items = names.map(name => ({name}));
        expect(pcaFilterLibrary(items)).toBe(items);
        expect(mergeDynamicAssets(spriteLibraryContent, []).data).toHaveLength(spriteLibraryContent.length);

        setPcaRuntime({features: {library: {source: 'local'}}});
        expect(pcaFilterLibrary(items).map(item => item.name)).toEqual(['Catcher', 'Abby', 'Meow']);

        const sprites = mergeDynamicAssets(spriteLibraryContent, []).data.map(sprite => sprite.name);
        expect(sprites).not.toContain('Cat');
        expect(sprites).toEqual(expect.arrayContaining(['Abby', 'Catcher']));
        expect(sprites).toHaveLength(spriteLibraryContent.length - 10);
        const costumes = mergeDynamicAssets(costumeLibraryContent, [{name: 'Gobo-z', isPublic: true}]).data;
        expect(costumes.filter(costume => /^(cat|gobo|pico|nano|tera|giga)(?![a-z])/i.test(costume.name)))
            .toEqual([]);
        expect(costumes).toHaveLength(costumeLibraryContent.length - 31);
    });

    test('library and microphone follow the page config', () => {
        setPcaRuntime({features: {library: {source: 'off'}, soundRecording: false}});
        expect(pcaLibraryEnabled()).toBe(false);
        expect(pcaSoundRecordingEnabled()).toBe(false);
        setPcaRuntime({features: {library: {source: 'local'}, soundRecording: true}});
        expect(pcaLibraryEnabled()).toBe(true);
        expect(pcaSoundRecordingEnabled()).toBe(true);
    });
});

describe('PCA API client', () => {
    const urls = {
        project: '/code/api/projects/abc',
        session: '/code/api/session',
        assets: '/code/api/assets/',
        meta: '/m',
        thumbnail: '/t',
        createProject: '/code/api/projects',
        template: null
    };

    beforeEach(() => {
        document.head.innerHTML = '<meta name="csrf-token" content="old-token">';
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('sends the CSRF token and the base version with a save', async () => {
        global.fetch = jest.fn(() => Promise.resolve(response(200, {version: 4})));
        const body = await new PcaApi(urls).saveProject('{}', 3, true);
        expect(body.version).toBe(4);
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('/code/api/projects/abc?base_version=3&autosave=1');
        expect(options.method).toBe('PUT');
        expect(options.credentials).toBe('same-origin');
        expect(options.headers['X-CSRFToken']).toBe('old-token');
    });

    test('refreshes a stale CSRF token once and retries', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce(response(400, {error: 'csrf'}))
            .mockResolvedValueOnce(response(200, {csrf_token: 'new-token'}))
            .mockResolvedValueOnce(response(200, {version: 2}));
        await new PcaApi(urls).saveProject('{}', 1, false);
        expect(global.fetch.mock.calls[1][0]).toBe('/code/api/session');
        expect(global.fetch.mock.calls[2][1].headers['X-CSRFToken']).toBe('new-token');
    });

    test('reports conflicts, sign-outs and network failures as such', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce(response(409, {error: 'conflict', current_version: 7}))
            .mockResolvedValueOnce(response(401, {error: 'signed_out'}))
            .mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const api = new PcaApi(urls);
        const conflict = await api.saveProject('{}', 1, false).catch(e => e);
        expect(conflict).toBeInstanceOf(PcaApiError);
        expect(conflict.isConflict).toBe(true);
        expect(conflict.body.current_version).toBe(7);
        const signedOut = await api.saveProject('{}', 1, false).catch(e => e);
        expect(signedOut.isSignedOut).toBe(true);
        const offline = await api.saveProject('{}', 1, false).catch(e => e);
        expect(offline.isOffline).toBe(true);
    });

    test('reads the version of a loaded project from its header', async () => {
        global.fetch = jest.fn(() => Promise.resolve(response(200, null, {'X-Project-Version': '5'})));
        const loaded = await new PcaApi(urls).loadProject();
        expect(loaded.version).toBe(5);
        expect(loaded.data).toBeInstanceOf(Uint8Array);
    });
});

describe('PCA colour mode', () => {
    const {detectColorMode, persistColorMode} = require('../../../src/lib/settings/color-mode/persistence');

    const clearCookie = () => {
        document.cookie = 'scratchtheme=;path=/';
    };

    beforeEach(clearCookie);
    afterEach(() => {
        setPcaRuntime(null);
        clearCookie();
    });

    test('starts in the colour mode the page names', () => {
        setPcaRuntime({features: {colorMode: 'high-contrast'}});
        expect(detectColorMode()).toBe('high-contrast');
    });

    test('an unknown colour mode falls back to the system preference', () => {
        setPcaRuntime({features: {colorMode: 'neon'}});
        expect(detectColorMode()).toBe('default');
    });

    test('a child choosing Original is remembered over the page default', () => {
        setPcaRuntime({features: {colorMode: 'high-contrast'}});
        persistColorMode('default');
        expect(detectColorMode()).toBe('default');
        persistColorMode('high-contrast');
        expect(detectColorMode()).toBe('high-contrast');
    });
});

describe('PCA import from the computer', () => {
    const {PcaStorage} = require('../../../src/lib/pca/pca-storage');

    const config = {
        mode: 'edit',
        project: {id: 'current-project', version: 3},
        api: {
            project: '/code/api/projects/current-project',
            session: '/s',
            assets: '/code/api/assets/',
            meta: '/m',
            thumbnail: '/t',
            createProject: '/code/api/projects',
            template: null
        },
        features: {library: {source: 'off', assetBase: ''}}
    };
    const project = {
        targets: [
            {isStage: true, name: 'Stage', costumes: [{name: 'backdrop1', assetId: 'aaa', dataFormat: 'svg'}], sounds: []},
            {isStage: false, name: 'Cat', costumes: [{name: 'rocket', md5ext: 'bbb.png'}], sounds: []}
        ]
    };
    const makeStorage = () => {
        const storage = new PcaStorage(config);
        const vm = {
            toJSON: () => JSON.stringify(project),
            assets: [
                {assetId: 'aaa', dataFormat: 'svg', data: new Uint8Array([1])},
                {assetId: 'bbb', dataFormat: 'png', data: new Uint8Array([2])}
            ]
        };
        storage.getState = () => ({scratchGui: {vm, projectState: {loadingState: 'SHOWING_WITH_ID'}}});
        return storage;
    };

    beforeEach(() => {
        document.head.innerHTML = '<meta name="csrf-token" content="token">';
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('uploads every costume and sound, then creates a new project', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce(response(201, {md5ext: 'aaa.svg', created: true}))
            .mockResolvedValueOnce(response(201, {md5ext: 'bbb.png', created: true}))
            .mockResolvedValueOnce(response(201, {public_id: 'new-project', version: 1, title: 'Game'}));
        const publicId = await makeStorage().importAsNewProject('Game');
        expect(publicId).toBe('new-project');
        const urls = global.fetch.mock.calls.map(call => `${call[1].method} ${call[0]}`);
        expect(urls).toEqual([
            'PUT /code/api/assets/aaa.svg',
            'PUT /code/api/assets/bbb.png',
            'POST /code/api/projects?title=Game'
        ]);
    });

    test('a refused costume is named', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce(response(201, {md5ext: 'aaa.svg', created: true}))
            .mockResolvedValueOnce(response(422, {error: 'unsafe_svg', message: 'This picture contains a script.'}));
        const error = await makeStorage().importAsNewProject('Game')
            .catch(e => e);
        expect(error.described.kind).toBe('asset');
        expect(error.described.message).toContain('“rocket (Cat)”');
    });

    test('nothing is saved over the open project while a file is imported', async () => {
        global.fetch = jest.fn();
        const storage = makeStorage();
        storage.importing = true;
        await expect(storage.saveProject('current-project', '{}', {})).rejects.toThrow();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('PCA art packs in the library', () => {
    afterEach(() => setPcaRuntime(null));

    const kinds = [
        ['sprites', spriteLibraryContent],
        ['costumes', costumeLibraryContent],
        ['backdrops', backdropLibraryContent]
    ];
    const pictures = entry => (entry.costumes ? entry.costumes : [entry]);

    test('every entry is a public picture from a credited pack, with a pack tag', () => {
        expect(pcaLibraryPackCredits.map(pack => pack.licence)).toEqual(['CC0-1.0', 'CC0-1.0', 'CC0-1.0', 'CC0-1.0']);
        expect(pcaLibraryPacks.sounds).toEqual([]);
        for (const [kind] of kinds) {
            expect(pcaLibraryPacks[kind].length).toBeGreaterThan(0);
            for (const entry of pcaLibraryPacks[kind]) {
                expect(entry.isPublic).toBe(true);
                expect(entry.tags.some(tag => tag === 'platformer' || tag === 'halloween')).toBe(true);
                for (const costume of pictures(entry)) {
                    expect(costume.md5ext).toBe(`${costume.assetId}.png`);
                    expect(costume.assetId).toMatch(/^[0-9a-f]{32}$/);
                    expect(costume.dataFormat).toBe('png');
                    expect(costume.bitmapResolution).toBe(2);
                }
            }
        }
    });

    test('no pack entry shares a name with another entry or with the Scratch library', () => {
        // mergeDynamicAssets keeps the bundled entry when names match, so a
        // clash would silently hide ours.
        for (const [kind, bundled] of kinds) {
            const names = pcaLibraryPacks[kind].map(entry => entry.name.toLowerCase());
            expect(new Set(names).size).toBe(names.length);
            const taken = new Set(bundled.map(entry => entry.name.toLowerCase()));
            expect(names.filter(name => taken.has(name))).toEqual([]);
        }
    });

    test('pack entries are listed on a PCA page, not as member-only, with their tag buttons', () => {
        setPcaRuntime({features: {library: {source: 'local'}}});
        const sprites = mergeDynamicAssets(spriteLibraryContent, pcaLibraryPacks.sprites).data;
        expect(sprites).toHaveLength(spriteLibraryContent.length - 10 + pcaLibraryPacks.sprites.length);
        const crypt = sprites.find(sprite => sprite.name === 'Halloween Crypt');
        expect(crypt.isMemberOnly).toBeUndefined();
        expect(crypt.tags).not.toContain('membership');

        const spriteButtons = pcaLibraryTags(spriteTags, sprites).map(button => button.tag);
        expect(spriteButtons.slice(-2)).toEqual(['platformer', 'halloween']);
        expect(pcaLibraryTags(spriteTags, sprites)).toBe(pcaLibraryTags(spriteTags, sprites));
        const backdrops = mergeDynamicAssets(backdropLibraryContent, pcaLibraryPacks.backdrops).data;
        // Some of Scratch's own backdrops are tagged halloween too, so both buttons show.
        expect(pcaLibraryTags(backdropTags, backdrops).map(button => button.tag)).toContain('platformer');
        expect(pcaLibraryTags(backdropTags, [{name: 'Room', tags: ['indoors']}])).toBe(backdropTags);

        setPcaRuntime(null);
        expect(pcaLibraryTags(spriteTags, sprites)).toBe(spriteTags);
    });
});
