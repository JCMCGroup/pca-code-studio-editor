#!/usr/bin/env node
// Builds the source projects the compatibility fixtures are made from.
//
//   node test/compat/make-sources.js <output-dir>
//
// Most sources are projects the Scratch Team made for scratch-vm's own tests:
// one per block category, the pen, music and micro:bit extension projects, and
// projects saved from scratch.mit.edu. Each is loaded in the unmodified
// scratch-vm and saved again as .sb3, which is what PCA Code Studio does when a
// child uses "Load from your computer" (sb2 files are converted on the way).
//
// A few sources no upstream fixture covers are built here: the Makey Makey
// extension, a PNG costume with an MP3 sound, and a project near the size limits.
//
// The output is not the fixture set. scripts/make_code_compat_fixtures.py in the
// PCA portal sends each source through the portal's real API and downloads it
// again from the real .sb3 export endpoint into test/compat/fixtures/.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const JSZip = require('jszip');
const {ScratchStorage} = require('@scratch/scratch-storage');
const VirtualMachine = require('../../packages/scratch-vm/src/index.js');

const UPSTREAM = path.resolve(__dirname, '../../packages/scratch-vm/test/fixtures');

/** name in the fixture set -> upstream file, relative to scratch-vm's fixtures */
const FROM_UPSTREAM = {
    'category-motion': 'motion.sb2',
    'category-looks': 'looks.sb2',
    'category-sound': 'sound.sb2',
    'category-events': 'event.sb2',
    'category-control': 'control.sb2',
    'category-sensing': 'sensing.sb2',
    'category-operators-and-data': 'data.sb2',
    'my-blocks': 'procedure.sb2',
    'clones': 'clone-cleanup.sb2',
    'broadcasts': 'broadcast_special_chars.sb3',
    'cloud-variable': 'cloud_variables_simple.sb3',
    'variables-and-lists-monitors': 'monitors.sb3',
    'comments': 'comments.sb3',
    'extension-pen': 'load-extensions/confirm-load/pen-simple-project.sb3',
    'extension-music': 'load-extensions/confirm-load/music-simple-project.sb3',
    'extension-microbit': 'load-extensions/confirm-load/microbit-simple-project.sb3',
    'from-scratch-mit-edu': 'origin.sb3',
    'from-scratch-default': 'default.sb3'
};

const md5 = data => crypto.createHash('md5').update(data)
    .digest('hex');

const convert = async buffer => {
    const vm = new VirtualMachine();
    vm.attachStorage(new ScratchStorage());
    await vm.loadProject(buffer);
    const blob = await vm.saveProjectSb3();
    vm.quit();
    return Buffer.from(await blob.arrayBuffer());
};

// -- built here ------------------------------------------------------------------

const BACKDROP = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">' +
    '<rect width="480" height="360" fill="#ffffff"/></svg>'
);

const pngChunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
};

/** A real 32x32 RGBA PNG, a teal square. */
const tealPng = () => {
    const width = 32;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(width, 4);
    header.writeUInt8(8, 8); // bit depth
    header.writeUInt8(6, 9); // RGBA
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, Buffer.from([15, 157, 143, 255]))]);
    const pixels = zlib.deflateSync(Buffer.concat(Array(width).fill(row)));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header), pngChunk('IDAT', pixels), pngChunk('IEND', Buffer.alloc(0))
    ]);
};

/** A short MPEG-1 Layer III stream of silent frames (128 kbps, 44.1 kHz). */
const silentMp3 = () => {
    const frame = Buffer.alloc(417);
    frame.writeUInt32BE(0xfffb9064, 0);
    return Buffer.concat(Array(40).fill(frame));
};

/** A mono 16-bit WAV of silence, ``bytes`` of samples long. */
const silentWav = bytes => {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + bytes, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(22050, 24);
    header.writeUInt32LE(44100, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(bytes, 40);
    return Buffer.concat([header, Buffer.alloc(bytes)]);
};

const costume = (name, data, ext, extra = {}) => ({
    name, assetId: md5(data), md5ext: `${md5(data)}.${ext}`, dataFormat: ext, ...extra
});

const buildProject = async ({sprite, stage = {}, extensions = [], files}) => {
    const project = {
        targets: [
            {
                isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
                comments: {}, currentCostume: 0,
                costumes: [costume('backdrop1', BACKDROP, 'svg', {rotationCenterX: 240, rotationCenterY: 180})],
                sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50,
                videoState: 'on', textToSpeechLanguage: null, ...stage
            },
            {
                isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {}, blocks: {},
                comments: {}, currentCostume: 0, sounds: [], volume: 100, layerOrder: 1,
                visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false,
                rotationStyle: 'all around', ...sprite
            }
        ],
        monitors: [],
        extensions,
        meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}
    };
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(project));
    zip.file(md5(BACKDROP) + '.svg', BACKDROP);
    for (const [name, data] of Object.entries(files)) zip.file(name, data);
    return convert(await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));
};

/** A 32x32 bitmap at resolution 1, centred. */
const SQUARE = {bitmapResolution: 1, rotationCenterX: 16, rotationCenterY: 16};

const BUILT = {
    'extension-makeymakey': () => {
        const png = tealPng();
        return buildProject({
            extensions: ['makeymakey'],
            sprite: {
                costumes: [costume('square', png, 'png', SQUARE)],
                blocks: {
                    hat: {
                        opcode: 'makeymakey_whenMakeyKeyPressed', next: 'say', parent: null,
                        inputs: {KEY: [1, 'key']}, fields: {}, shadow: false, topLevel: true, x: 40, y: 40
                    },
                    key: {
                        opcode: 'makeymakey_menu_KEY', next: null, parent: 'hat', inputs: {},
                        fields: {KEY: ['SPACE', null]}, shadow: true, topLevel: false
                    },
                    say: {
                        opcode: 'looks_sayforsecs', next: null, parent: 'hat',
                        inputs: {MESSAGE: [1, [10, 'Boing!']], SECS: [1, [4, '1']]},
                        fields: {}, shadow: false, topLevel: false
                    }
                }
            },
            files: {[`${md5(png)}.png`]: png}
        });
    },
    'media-png-and-mp3': () => {
        const png = tealPng();
        const mp3 = silentMp3();
        return buildProject({
            sprite: {
                costumes: [
                    costume('bitmap', png, 'png', {bitmapResolution: 2, rotationCenterX: 32, rotationCenterY: 32})
                ],
                sounds: [costume('silence', mp3, 'mp3', {rate: 44100, sampleCount: 44100})]
            },
            files: {[`${md5(png)}.png`]: png, [`${md5(mp3)}.mp3`]: mp3}
        });
    },
    'near-size-limits': () => {
        // project.json just under 5 MB (a long list) and a sound just under 10 MB.
        const wav = silentWav((9.5 * 1024 * 1024) - 44);
        const items = Array.from({length: 62000}, (_, i) => `high score entry number ${i} with padding text ok`);
        return buildProject({
            stage: {lists: {bigList: ['scores', items]}},
            sprite: {
                costumes: [costume('square', tealPng(), 'png', SQUARE)],
                sounds: [costume('long silence', wav, 'wav', {rate: 22050, sampleCount: wav.length / 2})]
            },
            files: {[`${md5(tealPng())}.png`]: tealPng(), [`${md5(wav)}.wav`]: wav}
        });
    }
};

(async () => {
    const out = process.argv[2];
    if (!out) {
        process.stderr.write('usage: node test/compat/make-sources.js <output-dir>\n');
        process.exit(2);
    }
    fs.mkdirSync(out, {recursive: true});
    for (const [name, file] of Object.entries(FROM_UPSTREAM)) {
        const buffer = await convert(fs.readFileSync(path.join(UPSTREAM, file)));
        fs.writeFileSync(path.join(out, `${name}.sb3`), buffer);
        process.stdout.write(`${name}.sb3  <- scratch-vm/test/fixtures/${file}\n`);
    }
    for (const [name, build] of Object.entries(BUILT)) {
        fs.writeFileSync(path.join(out, `${name}.sb3`), await build());
        process.stdout.write(`${name}.sb3  <- built by make-sources.js\n`);
    }
    // The VM leaves timers running after quit(), so end the process explicitly.
    process.exit(0);
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
});
