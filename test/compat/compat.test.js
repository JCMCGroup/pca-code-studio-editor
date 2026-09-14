// Scratch 3 compatibility harness for PCA Code Studio.
//
//   node --test --test-force-exit test/compat/compat.test.js
//
// Every file in test/compat/fixtures/ was downloaded from the PCA portal's real
// GET /code/api/projects/<id>/export.sb3 endpoint (see README.md). Each one is
// checked with the unmodified scratch-parser and scratch-vm from this repository:
//
//   1. scratch-parser accepts it;
//   2. vm.loadProject succeeds without a single warning or error being logged
//      (nor while it saves the project again);
//   3. vm.saveProjectSb3() then loading that into a fresh VM gives the same
//      project.json (ignoring what Scratch itself changes on every load);
//   4. every costume and sound file's MD5 matches its file name, both in the
//      portal's download and in the file scratch-vm saves again;
//   5. the download is laid out as the portal promises: project.json and the
//      files it uses at the root of the zip, nothing else, meta.agent empty.
//
// Node has no canvas, image decoder or Web Audio, so the harness supplies the
// same kind of stand-ins scratch-vm's own tests use (test/fixtures/fake-renderer.js,
// given real layering in layered-fake-renderer.js, and a mock Image/canvas).
// Like the editor, it gives the VM the English block names from scratch-l10n.
// The stand-ins still read each file's header: a PNG, JPEG, WAV or MP3 that
// could not be decoded makes the VM log a warning and the fixture fails.
// Checking that pixels and samples are right is the manual acceptance check in
// the portal's docs/guides/STAFF_GUIDE.md.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const zlib = require('node:zlib');

const JSZip = require('jszip');
const parser = require('scratch-parser');
const {ScratchStorage} = require('@scratch/scratch-storage');

const VM_ROOT = path.resolve(__dirname, '../../packages/scratch-vm');
const VirtualMachine = require(path.join(VM_ROOT, 'src/index.js'));
const vmLog = require(path.join(VM_ROOT, 'src/util/log.js'));
const dispatch = require(path.join(VM_ROOT, 'src/dispatch/central-dispatch.js'));
const FakeBitmapAdapter = require(path.join(VM_ROOT, 'test/fixtures/fake-bitmap-adapter.js'));
const formatMessage = require(require.resolve('format-message', {paths: [VM_ROOT]}));
const LayeredFakeRenderer = require('./layered-fake-renderer');

const FIXTURES = path.join(__dirname, 'fixtures');
const ASSET_NAME = /^[0-9a-f]{32}\.(svg|png|jpg|wav|mp3)$/;

const md5 = data => crypto.createHash('md5').update(data)
    .digest('hex');

// -- what scratch-vm logs ---------------------------------------------------------

let logged = [];
vmLog.settings.type = 'hidden';
vmLog.attachTransport(entry => {
    const level = entry._meta && entry._meta.logLevelName;
    if (level === 'WARN' || level === 'ERROR' || level === 'FATAL') {
        const parts = Object.keys(entry).filter(key => key !== '_meta')
            .map(key => entry[key]);
        logged.push(`${level}: ${parts.map(String).join(' ')}`);
    }
});
// Anything logged around the VM's logger counts too.
const logTo = method => (...args) => logged.push(`console.${method}: ${args.map(String).join(' ')}`);
console.warn = logTo('warn');
console.error = logTo('error');

// -- what the editor sets up -------------------------------------------------------

// scratch-gui hands the VM its English messages (reducers/locales.js). The
// generated file is an ES module, so read its object literal as JSON.
const editorMessagesSource = fs.readFileSync(require.resolve('scratch-l10n/locales/editor-msgs.js'), 'utf8');
const editorMessages = JSON.parse(editorMessagesSource
    .slice(editorMessagesSource.indexOf('export default') + 'export default'.length)
    .trim()
    .replace(/;\s*$/, ''));
formatMessage.setup({locale: 'en', translations: {en: editorMessages.en}});

// -- stand-ins for the browser ------------------------------------------------------

// scratch-svg-renderer's BitmapAdapter decodes data URIs with window.atob; Node
// has no window (and scratch-vm behaves differently when there is one).
FakeBitmapAdapter.prototype.convertDataURIToBinary = function (dataURI) {
    return new Uint8Array(Buffer.from(dataURI.slice(dataURI.indexOf(',') + 1), 'base64'));
};

/** Width and height from a PNG or JPEG header, or null if it isn't one. */
const imageSize = data => {
    if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString('ascii', 12, 16) === 'IHDR') {
        return {width: data.readUInt32BE(16), height: data.readUInt32BE(20)};
    }
    if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < data.length && data[offset] === 0xff) {
            const marker = data[offset + 1];
            const length = data.readUInt16BE(offset + 2);
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                return {width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5)};
            }
            offset += 2 + length;
        }
    }
    return null;
};

const pngChunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
};

/** A transparent PNG of the given size: what a mock canvas "draws". */
const blankPng = (width, height) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(Math.max(1, width), 0);
    header.writeUInt32BE(Math.max(1, height), 4);
    header.writeUInt8(8, 8);
    header.writeUInt8(6, 9);
    const row = Buffer.alloc(1 + (Math.max(1, width) * 4));
    const pixels = zlib.deflateSync(Buffer.concat(Array(Math.max(1, height)).fill(row)));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header), pngChunk('IDAT', pixels), pngChunk('IEND', Buffer.alloc(0))
    ]);
};

global.Image = function () {
    const image = {width: 0, height: 0};
    Object.defineProperty(image, 'src', {
        set (uri) {
            setImmediate(() => {
                const size = imageSize(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64'));
                if (size && size.width > 0 && size.height > 0) {
                    Object.assign(image, size);
                    image.onload();
                } else {
                    image.onerror();
                }
            });
        }
    });
    return image;
};

global.document = {
    createElement: () => {
        const canvas = {
            width: 0,
            height: 0,
            getContext: () => ({drawImage: () => {}}),
            toDataURL: () => `data:image/png;base64,${blankPng(canvas.width, canvas.height).toString('base64')}`
        };
        return canvas;
    }
};

/** Sample rate and length from a WAV or MP3 header, or null if it isn't one. */
const soundInfo = (data, sound) => {
    if (data.length > 44 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') {
        let offset = 12;
        let format = null;
        while (offset + 8 <= data.length) {
            const id = data.toString('ascii', offset, offset + 4);
            const size = data.readUInt32LE(offset + 4);
            if (id === 'fmt ') {
                format = {rate: data.readUInt32LE(offset + 12), blockAlign: data.readUInt16LE(offset + 20)};
            } else if (id === 'data' && format) {
                return {sampleRate: format.rate, length: Math.floor(size / (format.blockAlign || 1))};
            }
            offset += 8 + size + (size % 2);
        }
        return null;
    }
    const mp3Start = data.toString('ascii', 0, 3) === 'ID3' ? (10 + (
        (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9])) : 0;
    if (data.length > mp3Start + 4 && data[mp3Start] === 0xff && (data[mp3Start + 1] & 0xe0) === 0xe0) {
        return {sampleRate: sound.rate, length: sound.sampleCount};
    }
    return null;
};

const fakeAudioEngine = () => {
    let nextId = 0;
    return {
        createBank: () => ({addSoundPlayer: () => {}, dispose: () => {}}),
        getLoudness: () => -1,
        decodeSoundPlayer: sound => {
            const info = soundInfo(Buffer.from(sound.data), sound);
            if (!info) return Promise.reject(new Error('Sound could not be decoded.'));
            return Promise.resolve({id: `sound-${nextId++}`, buffer: info});
        }
    };
};

// -- helpers --------------------------------------------------------------------------

const newVm = () => {
    const vm = new VirtualMachine();
    vm.attachStorage(new ScratchStorage());
    vm.attachRenderer(new LayeredFakeRenderer());
    vm.attachV2BitmapAdapter(new FakeBitmapAdapter());
    vm.attachAudioEngine(fakeAudioEngine());
    return vm;
};

/**
 * Stop a VM. Each VM registers its extensions with the process-wide dispatcher;
 * a browser page has one VM, so forget them before the next VM starts.
 */
const quit = vm => {
    vm.quit();
    for (const service of Object.keys(dispatch.services)) {
        if (service.startsWith('extension_')) delete dispatch.services[service];
    }
};

const parse = buffer => new Promise((resolve, reject) => {
    parser(buffer, false, (error, result) => {
        if (error) {
            reject(new assert.AssertionError({message: `scratch-parser refused it: ${JSON.stringify(error)}`}));
        } else {
            resolve(result);
        }
    });
});

/**
 * project.json without what legitimately differs from one load to the next:
 * meta.agent names the browser, and a sprite's monitors are named after the
 * sprite's runtime id, which scratch-vm makes up afresh (20 characters, uid.js)
 * each time a project loads. Those are named after the sprite instead.
 */
const RUNTIME_ID_LENGTH = 20;
const normalised = json => {
    const project = JSON.parse(json);
    delete project.meta.agent;
    for (const monitor of project.monitors) {
        if (monitor.spriteName && monitor.id.charAt(RUNTIME_ID_LENGTH) === '_') {
            monitor.id = `${monitor.spriteName}${monitor.id.slice(RUNTIME_ID_LENGTH)}`;
        }
    }
    return project;
};

const assetsOf = project => {
    const names = new Set();
    for (const target of project.targets) {
        for (const item of [...target.costumes, ...target.sounds]) {
            names.add(item.md5ext || `${item.assetId}.${item.dataFormat}`);
        }
    }
    return names;
};

/** Every entry in an sb3, checked: files at the root, names are the file's own MD5. */
const readSb3 = async buffer => {
    const zip = await JSZip.loadAsync(buffer);
    const files = {};
    for (const entry of Object.values(zip.files)) {
        assert.equal(entry.dir, false, `${entry.name} is a folder`);
        assert.ok(!entry.name.includes('/'), `${entry.name} is not at the root of the zip`);
        files[entry.name] = await entry.async('nodebuffer');
    }
    assert.ok(files['project.json'], 'there is no project.json');
    const project = JSON.parse(files['project.json'].toString('utf8'));
    for (const [name, data] of Object.entries(files)) {
        if (name === 'project.json') continue;
        assert.match(name, ASSET_NAME, `${name} is not named <md5>.<ext>`);
        assert.equal(`${md5(data)}.${name.split('.')[1]}`, name, `${name}'s contents have a different MD5`);
    }
    return {project, files};
};

const noWarnings = what => assert.deepEqual(logged, [], `scratch-vm logged problems ${what}`);

const loadWithoutWarnings = async (vm, buffer, what) => {
    logged = [];
    await vm.loadProject(buffer);
    assert.deepEqual(logged, [], `scratch-vm logged problems loading ${what}`);
    for (const target of vm.runtime.targets) {
        for (const item of [...target.getCostumes(), ...target.getSounds()]) {
            assert.equal(item.broken, undefined, `${target.getName()}'s “${item.name}” did not load in ${what}`);
        }
    }
};

/** All five checks for one .sb3 file. Rejects with the first thing wrong. */
const checkSb3 = async buffer => {
    // 5. the portal's download
    const download = await readSb3(buffer);
    assert.equal(download.project.meta.agent, '', 'meta.agent is not empty');
    assert.deepEqual(new Set(Object.keys(download.files).filter(n => n !== 'project.json')),
        assetsOf(download.project), 'the zip does not hold exactly the files project.json uses');

    // 1. scratch-parser
    const [parsed] = await parse(buffer);
    assert.equal(parsed.projectVersion, 3, 'scratch-parser did not read it as Scratch 3');

    // 2. scratch-vm loads it
    let loaded;
    let saved;
    const first = newVm();
    try {
        await loadWithoutWarnings(first, buffer, 'the download');
        loaded = first.toJSON();
        saved = Buffer.from(await (await first.saveProjectSb3()).arrayBuffer());
        noWarnings('saving the download again');
    } finally {
        quit(first);
    }

    // 3. save and load again (and 4. for the saved copy too)
    const resaved = await readSb3(saved);
    const [reparsed] = await parse(saved);
    assert.equal(reparsed.projectVersion, 3);
    const second = newVm();
    try {
        await loadWithoutWarnings(second, saved, 'the saved copy');
        const reloaded = second.toJSON();
        noWarnings('saving the saved copy');
        assert.deepEqual(normalised(reloaded), normalised(loaded),
            'project.json changed after saving and loading again');
    } finally {
        quit(second);
    }
    assert.deepEqual(normalised(JSON.stringify(resaved.project)), normalised(loaded),
        'the saved project.json is not what the VM held');
};

// -- the fixtures -------------------------------------------------------------------------

const fixtures = fs.readdirSync(FIXTURES).filter(name => name.endsWith('.sb3'))
    .sort();

test('there are fixtures to check', () => {
    assert.ok(fixtures.length >= 20, `only ${fixtures.length} fixtures in ${FIXTURES}`);
});

for (const name of fixtures) {
    test(name, () => checkSb3(fs.readFileSync(path.join(FIXTURES, name))));
}

// -- the harness itself -----------------------------------------------------------------------
// Each of these is a broken copy of a fixture. If the harness passed any of them,
// its passes above would mean nothing.

const brokenCopy = async (name, change) => {
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(FIXTURES, name)));
    const project = JSON.parse(await zip.file('project.json').async('string'));
    await change(zip, project);
    zip.file('project.json', JSON.stringify(project));
    return zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
};

const firstAsset = (project, ext) => {
    for (const target of project.targets) {
        for (const item of [...target.costumes, ...target.sounds]) {
            if (item.dataFormat === ext) return item;
        }
    }
    throw new Error(`no .${ext} file`);
};

const SELF_CHECKS = {
    'a costume whose file is not a PNG': ['media-png-and-mp3.sb3', (zip, project) => {
        const item = firstAsset(project, 'png');
        const junk = Buffer.from('this is not a picture');
        zip.remove(item.md5ext);
        item.assetId = md5(junk);
        item.md5ext = `${item.assetId}.png`;
        zip.file(item.md5ext, junk);
    }],
    'a sound whose file is not a WAV': ['near-size-limits.sb3', (zip, project) => {
        const item = firstAsset(project, 'wav');
        const junk = Buffer.from('this is not a sound');
        zip.remove(item.md5ext);
        item.assetId = md5(junk);
        item.md5ext = `${item.assetId}.wav`;
        zip.file(item.md5ext, junk);
    }],
    'a file whose name is not its MD5': ['blank.sb3', async (zip, project) => {
        const item = firstAsset(project, 'svg');
        const data = await zip.file(item.md5ext).async('nodebuffer');
        zip.file(item.md5ext, Buffer.concat([data, Buffer.from('<!-- changed -->')]));
    }],
    'a costume file that is missing': ['blank.sb3', (zip, project) => {
        zip.remove(firstAsset(project, 'svg').md5ext);
    }],
    'an extra file in the zip': ['blank.sb3', zip => {
        zip.file('notes.txt', 'hello');
    }],
    'a file inside a folder': ['blank.sb3', async (zip, project) => {
        const item = firstAsset(project, 'svg');
        zip.file(`assets/${item.md5ext}`, await zip.file(item.md5ext).async('nodebuffer'));
    }],
    'meta.agent naming a browser': ['blank.sb3', (zip, project) => {
        project.meta.agent = 'Mozilla/5.0';
    }],
    'a project scratch-parser refuses': ['blank.sb3', (zip, project) => {
        project.targets[1].layerOrder = 'top';
    }],
    'a sprite whose monitor belongs to no sprite': ['variables-and-lists-monitors.sb3', (zip, project) => {
        const monitor = project.monitors.find(m => m.spriteName);
        monitor.spriteName = 'Nobody'; // the VM warns while loading
    }]
};

for (const [what, [name, change]] of Object.entries(SELF_CHECKS)) {
    test(`the harness fails ${what}`, async t => {
        const broken = await brokenCopy(name, change);
        await assert.rejects(checkSb3(broken), error => {
            assert.ok(error instanceof assert.AssertionError, error);
            t.diagnostic(error.message.split('\n')[0]);
            return true;
        });
    });
}
