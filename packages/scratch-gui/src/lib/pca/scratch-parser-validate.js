// PCA patch: stands in for scratch-parser's lib/validate.js in the editor build
// (webpack.config.js swaps it in). The checks and results are the same, but the
// validators are generated at build time by scripts/pca-project-validators.js,
// so loading a project never compiles code with `new Function` and the editor
// page does not need 'unsafe-eval'. Keep in step with lib/validate.js in the
// scratch-parser version scratch-vm pins.
//
// CommonJS on purpose: scratch-parser loads this with require() and wraps the
// exported function with pify.
const validators = require('../../generated/project-validators.cjs');

module.exports = function (isSprite, input, callback) {
    const validateSb2 = isSprite ? validators.sprite2 : validators.sb2;
    const validateSb3 = isSprite ? validators.sprite3 : validators.sb3;

    if (validateSb2(input)) {
        input.projectVersion = 2;
        return callback(null, input);
    }

    if (validateSb3(input)) {
        input.projectVersion = 3;
        return callback(null, input);
    }

    callback({
        validationError: 'Could not parse as a valid SB2 or SB3 project.',
        sb2Errors: validateSb2.errors,
        sb3Errors: validateSb3.errors
    });
};
