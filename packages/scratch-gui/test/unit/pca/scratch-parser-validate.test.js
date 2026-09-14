/**
 * @jest-environment node
 */
// PCA patch check: the validators generated at build time by
// scripts/pca-project-validators.js must reach the same verdict as
// scratch-parser's own lib/validate.js, which compiles the same schemas with
// ajv 6 at run time. Every project and sprite fixture in the repository is
// validated both ways, as it is and after edits that break the schema rules.
import fs from 'fs';
import path from 'path';

const {buildProjectValidators} = require('../../../scripts/pca-project-validators');
const unpack = require('scratch-parser/lib/unpack');
const parse = require('scratch-parser/lib/parse');
const upstreamValidate = require('scratch-parser/lib/validate');

const FIXTURE_DIRS = [
    path.resolve(__dirname, '../../fixtures'),
    path.resolve(__dirname, '../../../../scratch-vm/test/fixtures'),
    path.join(path.dirname(require.resolve('scratch-parser/package.json')), 'test', 'fixtures', 'data')
];
const PROJECT_FILE = /\.(sb|sb2|sb3|sprite2|sprite3|json|sprite2json|zip)$/;

const firstTarget = project => (Array.isArray(project.targets) ? project.targets[0] : null);
const MUTATIONS = [
    ['no targets', project => delete project.targets],
    ['no meta', project => delete project.meta],
    ['target is a number', project => Array.isArray(project.targets) && (project.targets[0] = 5)],
    ['blocks is an array', project => firstTarget(project) && (firstTarget(project).blocks = [])],
    ['isStage is a string', project => firstTarget(project) && (firstTarget(project).isStage = 'yes')],
    ['empty costume', project => {
        const target = firstTarget(project);
        if (target && Array.isArray(target.costumes)) target.costumes[0] = {};
    }],
    ['bad asset id', project => {
        const target = firstTarget(project);
        if (target && Array.isArray(target.costumes) && target.costumes[0]) target.costumes[0].assetId = 'not-an-md5!';
    }],
    ['bad semver', project => project.meta && (project.meta.semver = 'banana')],
    ['numeric opcode', project => {
        const target = firstTarget(project);
        const block = target && target.blocks && Object.values(target.blocks)[0];
        if (block && typeof block === 'object' && !Array.isArray(block)) block.opcode = 3;
    }],
    ['negative layer order', project => firstTarget(project) && (firstTarget(project).layerOrder = -1)],
    ['bad variable', project => {
        const target = Array.isArray(project.targets) && project.targets[1];
        if (target && target.variables) target.variables.x = [1];
    }],
    ['Scratch 2 name is a number', project => 'objName' in project && (project.objName = 7)],
    ['Scratch 2 child is a string', project => Array.isArray(project.children) && project.children.push('x')],
    ['Scratch 2 sounds is an object', project => 'sounds' in project && (project.sounds = {})],
    ['Scratch 2 resolution is a string', project => {
        if (Array.isArray(project.costumes) && project.costumes[0]) project.costumes[0].bitmapResolution = '2';
    }],
    ['extra property', project => (project.extra = {nested: [1, 2, 3]})]
];

const listFixtures = dir => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) return listFixtures(file);
        return PROJECT_FILE.test(entry.name) ? [file] : [];
    });
};

const readProject = (buffer, isSprite) => new Promise(resolve => {
    unpack(buffer, isSprite, (unpackError, unpacked) => {
        if (unpackError) return resolve(null);
        parse(unpacked[0], (parseError, project) => resolve(parseError ? null : project));
    });
});

const clone = value => JSON.parse(JSON.stringify(value));

const verdict = (validate, isSprite, project) => new Promise(resolve => {
    validate(isSprite, clone(project), (error, result) => {
        resolve(error ? 'invalid' : `sb${result.projectVersion}`);
    });
});

describe('PCA precompiled project validators', () => {
    let pcaValidate;

    beforeAll(() => {
        buildProjectValidators();
        pcaValidate = require('../../../src/lib/pca/scratch-parser-validate');
    });

    test('the generated code never compiles code at run time', () => {
        const source = fs.readFileSync(buildProjectValidators(), 'utf8');
        expect(source).not.toMatch(/new Function|\beval\(/);
    });

    test('agree with scratch-parser on every fixture, as it is and edited', async () => {
        const files = FIXTURE_DIRS.flatMap(listFixtures);
        expect(files.length).toBeGreaterThan(100);

        const mismatches = [];
        const verdictsSeen = new Set();
        let compared = 0;
        for (const file of files) {
            const buffer = fs.readFileSync(file);
            for (const isSprite of [false, true]) {
                const project = await readProject(buffer, isSprite);
                if (!project || typeof project !== 'object') continue;

                const variants = [['as it is', project]].concat(MUTATIONS.map(([name, edit]) => {
                    const edited = clone(project);
                    edit(edited);
                    return [name, edited];
                }));
                for (const [name, variant] of variants) {
                    const expected = await verdict(upstreamValidate, isSprite, variant);
                    const actual = await verdict(pcaValidate, isSprite, variant);
                    verdictsSeen.add(expected);
                    compared++;
                    if (expected !== actual) {
                        mismatches.push(`${path.basename(file)} (${isSprite ? 'sprite' : 'project'}, ${name}): ` +
                            `scratch-parser ${expected}, generated ${actual}`);
                    }
                }
            }
        }

        expect(mismatches).toEqual([]);
        // Valid Scratch 2 and Scratch 3 input and invalid input must all have been compared.
        expect([...verdictsSeen].sort()).toEqual(['invalid', 'sb2', 'sb3']);
        expect(compared).toBeGreaterThan(1000);
    }, 300000);
});
