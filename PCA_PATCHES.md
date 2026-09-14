# PCA Code Studio patches

This repository is Pixel Creators Academy's modified copy of
[scratchfoundation/scratch-editor](https://github.com/scratchfoundation/scratch-editor),
licensed AGPL-3.0-only like the original. It is kept in its own repository so the
complete source of the editor we serve can be published.

- Upstream remote: `upstream` → `https://github.com/scratchfoundation/scratch-editor.git`
- Pinned upstream release: see [`UPSTREAM_VERSION`](UPSTREAM_VERSION) (tag, then commit)
- Our branch: `pca`, based on that tag. Every PCA change is a commit on `pca`, so an
  upstream upgrade is `git rebase --onto <new-tag> <old-tag> pca`.
- Node: the version in [`.nvmrc`](.nvmrc). Node is a build-time tool only; the portal
  server never runs it.

Nothing from the Pixel Creators Academy portal (Python code, configuration, secrets,
hostnames) belongs in this repository. The portal talks to the editor only over
HTTP/JSON.

## Patches

Each entry: what changed, why, and the files touched. Keep this list in step with
the commits on `pca`.

The first three let the editor run under the portal's editor page
Content-Security-Policy, which has no `'unsafe-eval'` and no inline script. The
unmodified editor crashed on load under that policy (measured in Phase 0).

| # | Summary | Why | Files |
|---|---|---|---|
| 1 | Project and sprite validation uses validators generated at build time with ajv 8's standalone code generator, swapped in for `scratch-parser/lib/validate.js`. A jest test checks they reach the same verdict as scratch-parser over every project fixture, as it is and edited. | scratch-parser compiles its schemas with ajv 6 on every load, and ajv compiles with `new Function`; refused, the load fell through to the Scratch 1.4 reader and crashed the editor. | `packages/scratch-gui/scripts/pca-project-validators.js`, `packages/scratch-gui/src/lib/pca/scratch-parser-validate.js`, `packages/scratch-gui/webpack.config.js`, `packages/scratch-gui/test/unit/pca/scratch-parser-validate.test.js`, `packages/scratch-gui/package.json` (`ajv` 8.17.1, already in the lock file) |
| 2 | The SVG measurement and Paper.js sandbox loads a URL named by `<meta name="scratch-sandbox-frame-url">` in the host page instead of a `srcdoc` iframe; without the meta tag it behaves as upstream. The GUI build emits the page as `static/sandbox-frame.html`. | A `srcdoc` iframe inherits the host page's policy, so its inline runner script and its eval were refused and costume import timed out. The host must serve the page with its own policy including `sandbox allow-scripts`, so it keeps an opaque origin even when opened directly. | `packages/scratch-svg-renderer/src/sandbox/index.js`, `packages/scratch-gui/webpack.config.js` |
| 3 | scratch-storage's web build resolves its fetch-worker chunk against its own script URL (`publicPath: 'auto'`). | The default public path `/` requested the worker from the site root, which 404s when the editor is served from a sub-path. | `packages/scratch-storage/webpack.config.js` |

Patches 4 to 12 make the editor PCA Code Studio. Every upstream component they touch
checks `getPcaRuntime()` (`src/lib/pca/runtime.js`) and behaves exactly as upstream
when it is null, so the upstream playground pages still build and work unchanged.

| # | Summary | Why | Files |
|---|---|---|---|
| 4 | **Save/load adapter.** A new `pca` entry reads a JSON config block from the host page (`<script type="application/json" id="pca-editor-config">`) and mounts the GUI with `PcaStorage`, a `GUIStorage` that loads the project and costumes/sounds from the host portal's `/code/api` and saves through it: same-origin, the session cookie, the CSRF token from `<meta name="csrf-token">` (refreshed once from the session endpoint if it has gone stale). Upstream's `ProjectSaverHOC` is used unchanged; the project load and asset uploads are wrapped so the version header and error bodies survive. Missing assets reported by the portal are uploaded from the VM and the save retried once. | We control accounts, storage and sharing; nothing about a child needs a scratch.mit.edu account, and no request leaves our server. | `src/playground/pca.jsx`, `src/playground/render-pca.jsx`, `src/lib/pca/runtime.js`, `src/lib/pca/api.js`, `src/lib/pca/pca-storage.js`, `webpack.config.js` (the `pca` entry) |
| 5 | **Autosave, recovery and failures.** `PcaEditorHOC` wraps the GUI: autosave 30 seconds after the last change, on Save now and when the tab is hidden, retrying with back-off after a failure; a status pill (Saved / Saving… / Unsaved changes / Not saved – check your connection); a whole-project .sb3 recovery copy per project in IndexedDB, offered back as "Restore unsaved work" and deleted after a save that covers it or after 7 days; a signed-out dialog on 401 that keeps everything on screen; a conflict dialog on 409 (save as a copy, or load the newer version); refused costumes and sounds named. Upstream's save alerts are switched off through the props its HOCs already accept. `ProjectFetcherHOC` no longer marks the project unchanged when a *failed* save returns the editor to showing it (upstream treated that like a fresh load, so the unsaved work looked saved). | Never lose a child's work silently. | `src/lib/pca/pca-editor-hoc.jsx`, `src/lib/pca/recovery.js`, `src/lib/pca/pca-editor.css`, `src/lib/project-fetcher-hoc.jsx`, `test/unit/pca/pca-editor-support.test.js` |
| 6 | **Menus.** File → New opens the portal's new-project page; Tutorials (external video hosts) and Debug are hidden; upstream's Save Now link gives way to the status pill; Ctrl+S does nothing in a read-only view. Share, See project page, Remix, sign-in/join, My Stuff and Backpack are off through GUI props. | Children use only what the portal provides; no links out. | `src/components/menu-bar/menu-bar.jsx`, `src/playground/render-pca.jsx` |
| 7 | **Extensions, library and microphone.** The extension library lists only the portal's configured extensions (projects already using another official extension still load). When the media library is off, the library shows a notice and the Surprise buttons are hidden; when sound recording is off, Record is hidden (the page's Permissions-Policy also refuses the microphone). | Configured per deployment; camera, microphone and third-party services stay off by default. | `src/containers/extension-library.jsx`, `src/components/library/library.jsx`, `src/containers/sound-tab.jsx`, `src/containers/costume-tab.jsx`, `src/components/sprite-selector/sprite-selector.jsx`, `src/components/stage-selector/stage-selector.jsx` |
| 8 | **Rebranding and attribution.** Our own mark replaces the Scratch logo; the About menu opens a dialog with "Based on Scratch from the MIT Media Laboratory", the AGPL-3.0 notice and a link to this repository; the crash message no longer names Scratch or the Scratch Team; links to scratch.mit.edu are removed; the new-project sprite is a neutral placeholder instead of the Scratch Cat (the same file the portal starts projects with). | A modified editor may not use the Scratch name or marks, and must offer its source. | `src/lib/pca/pca-logo.svg`, `src/components/menu-bar/menu-bar.jsx`, `src/components/crash-message/crash-message.jsx`, `src/components/webgl-modal/webgl-modal.jsx`, `src/components/browser-modal/browser-modal.jsx`, `src/lib/alerts/index.jsx`, `src/components/stage-header/stage-header.jsx`, `src/lib/default-project/` |
| 9 | **Read-only and player modes.** `mode: "readonly"` shows a banner ("Viewing Amelia K's project – changes are not saved") and never saves, with "Save a copy to my templates" when the portal allows it; `mode: "player"` mounts only the stage (green flag, stop, full screen). A phone-sized touch screen gets the host page's "Open this on a laptop or tablet to edit" notice instead of the editor. | Staff and parents look without changing a child's work; projects play on any device. | `src/lib/pca/pca-editor-hoc.jsx`, `src/playground/pca.jsx`, `src/playground/render-pca.jsx` |
| 10 | **Colour mode.** A PCA page names the colour mode to start in (`features.colorMode`; the portal defaults to high contrast). It stands in for the system preference when the child has not chosen one, so a choice made in Settings, Original included, is still remembered in the `scratchtheme` cookie. | Readable blocks for every child by default. | `src/lib/settings/color-mode/persistence.js`, `src/playground/render-pca.jsx`, `test/unit/pca/pca-editor-support.test.js` |
| 11 | **Files on the computer.** File → Save to your computer saves first (waiting for the save to finish), then downloads the portal's own export (`api.export`), so the file always matches what the portal keeps and is named by the portal. File → Load from your computer loads the file in the VM, then makes it a *new* project: every costume and sound it uses is uploaded and the project.json created through the portal's API, and the editor moves to the new project. Nothing is saved over the open project while that happens; if the file is refused the dialog names the sprite and costume or sound, and says none of the child's projects changed. The upstream components ask `getPcaHooks()` (`src/lib/pca/runtime.js`), which `PcaEditorHOC` fills in; outside a PCA page they behave as upstream. | A child can take work home to Scratch and bring Scratch work in, and the portal still checks everything that arrives. | `src/lib/pca/runtime.js`, `src/containers/sb3-downloader.jsx`, `src/lib/sb-file-uploader-hoc.jsx`, `src/lib/pca/pca-storage.js`, `src/lib/pca/pca-editor-hoc.jsx`, `test/unit/pca/pca-editor-support.test.js` |
| 12 | **Trademarked characters left out of the library.** On a PCA page the sprite, costume, backdrop and sound library lists, and Surprise, leave out every entry named after the Scratch Cat, Gobo, Pico, Nano, Tera or Giga ("Cat-a", "Cat 2", "Pico Walk1"; "Catcher" stays). Only the lists change: a project or an .sb3 from the computer that already uses one of those costumes still loads, plays and saves. | A modified editor may not use the Scratch Foundation's marks (TRADEMARK), and the portal's media library mirror does not hold those files. | `src/lib/pca/runtime.js`, `src/lib/merge-dynamic-assets.js`, `test/unit/pca/pca-editor-support.test.js` |

### The page config (patches 4–12)

```json
{
  "mode": "edit | readonly | player",
  "project": {"id": "public id", "title": "", "version": 3, "ownerLabel": "Amelia K",
              "isOwner": true, "lastSavedAt": "ISO-8601 or null"},
  "api": {"project": "", "meta": "", "thumbnail": "", "createProject": "", "assets": "prefix",
          "session": "", "template": "or null", "export": ".sb3 download"},
  "urls": {"home": "", "projectPage": "", "editor": "", "newProject": "", "signIn": ""},
  "permissions": {"canSave": true, "canSaveTemplate": false},
  "features": {"extensions": ["pen"], "soundRecording": false, "videoSensing": false,
               "library": {"source": "local | upstream | off", "assetBase": "prefix"},
               "colorMode": "high-contrast | default"},
  "autosaveSeconds": 30,
  "about": {"name": "", "sourceUrl": "", "attribution": "", "buildId": "", "upstreamVersion": ""}
}
```

## Scratch 3 compatibility

`test/compat/` (not part of any workspace build) checks that `.sb3` files downloaded
from the portal load in the unmodified scratch-parser and scratch-vm without
warnings, survive a save and reload unchanged, and have every file named by its MD5.
Run `npm run test:compat`; see [`test/compat/README.md`](test/compat/README.md).

## Build

The portal's `scripts/build_editor.sh` / `scripts/build_editor.ps1` run the build and
copy the output into `app/static/editor/<build-id>/` in the portal. By hand:

```sh
npm ci --ignore-scripts          # skips canvas compilation and Playwright's Chromium download
node packages/scratch-gui/scripts/prepare.mjs   # downloads the micro:bit firmware the GUI bundles
NODE_ENV=production npm run build --workspace=packages/task-herder --workspace=packages/scratch-storage \
  --workspace=packages/scratch-svg-renderer --workspace=packages/scratch-paint \
  --workspace=packages/scratch-render --workspace=packages/scratch-vm
cd packages/scratch-gui
unset BUILD_TYPE GTM_ID GTM_ENV_AUTH GA_ID   # no Google Tag Manager in our build
NODE_ENV=production npx webpack --output-public-path auto
```

The portal installs only `build/pca.js` and what it loads (plus `static/sandbox-frame.html`).

The output is `packages/scratch-gui/build/`: with `NODE_ENV=production` and no
`BUILD_TYPE`, `packages/scratch-gui/webpack.config.js` selects its playground config.

Every editor package is built before the GUI, in upstream's workspace order, as
upstream CI's `npm run build` does. The GUI compiles scratch-vm, scratch-render,
scratch-paint and scratch-svg-renderer from `src/` (their `webpack` export condition),
but it still needs their builds: it type-checks against scratch-vm's `dist/`, and its
webpack config copies `extension-worker.js` and the fetch-worker chunks out of
scratch-vm's and scratch-storage's `dist/web/`, silently skipping them if they are
missing. task-herder and scratch-storage only publish `dist/`.
