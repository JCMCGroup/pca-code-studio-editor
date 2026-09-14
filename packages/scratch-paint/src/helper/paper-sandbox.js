import {Sandbox} from '@scratch/scratch-svg-renderer/sandbox';

import {createPaperImportScript} from './paper-import-script';

let paperSandboxPromise = null;

/**
 * Get or create the singleton Paper.js sandbox instance. The sandbox is
 * lazily created on first call and reused for all subsequent imports.
 * Paper.js source is loaded via a dynamic import (code-split chunk) to
 * avoid doubling the main bundle size.
 * @returns {Promise<Sandbox>} The Paper.js sandbox instance.
 */
const getPaperSandbox = () => {
    if (!paperSandboxPromise) {
        paperSandboxPromise = import(
            /* webpackChunkName: "paper-source" */
            '@scratch/paper/dist/paper-full.min.js?source'
        ).then(module => {
            const paperSource = module.default;
            const script = createPaperImportScript(paperSource);
            return new Sandbox(script);
        }).catch(err => {
            // Clear the cached promise so the next call retries rather
            // than returning the same permanent rejection.
            paperSandboxPromise = null;
            throw err;
        });
    }
    return paperSandboxPromise;
};

/**
 * Eagerly load the Paper.js chunk and warm the sandbox iframe (create it and
 * evaluate Paper.js inside it) so the first costume import pays none of the
 * cold-start cost. Best-effort: a failure here is swallowed and retried
 * lazily by the first real `importSvg`.
 * @returns {Promise<void>} Resolves once warm-up completes or is abandoned.
 */
const prewarmPaperSandbox = () =>
    getPaperSandbox()
        .then(sandbox => sandbox.warmUp())
        .catch(() => {});

export {getPaperSandbox, prewarmPaperSandbox};
