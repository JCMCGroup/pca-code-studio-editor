# Scratch 3 compatibility harness

Checks that the `.sb3` files the PCA portal hands out are ordinary Scratch 3
projects: what a child downloads opens in the Scratch desktop app and on
scratch.mit.edu, and loads back into PCA Code Studio unchanged.

```sh
node --test --test-force-exit test/compat/compat.test.js
```

(`npm run test:compat` from the repository root does the same.) `--test-force-exit`
is needed because scratch-vm leaves timers running after `quit()`.

## What is checked

For every file in `fixtures/`, using the unmodified `scratch-parser` and
`packages/scratch-vm` from this repository:

1. scratch-parser accepts it as a Scratch 3 project;
2. `vm.loadProject` succeeds, no costume or sound is marked broken, and nothing is
   logged at warning level or above (scratch-vm's logger or the console) while
   loading or saving again;
3. `vm.saveProjectSb3()` and loading that into a fresh VM gives the same
   project.json, apart from `meta.agent` and the runtime sprite id in a sprite's
   monitor ids, both of which Scratch itself changes on every load;
4. every costume and sound file's MD5 matches its file name, in the download and
   in the file scratch-vm saves again;
5. the download has project.json and exactly the files it uses at the root of the
   zip, and an empty `meta.agent`.

The harness then breaks copies of the fixtures (a PNG that is not a picture, a WAV
that is not a sound, a file whose name is not its MD5, a missing or extra file, a
file in a folder, a browser in `meta.agent`, a project scratch-parser refuses, a
monitor for a sprite that does not exist) and checks it fails every one, so a pass
means something.

Node has no canvas, image decoder or Web Audio. As in scratch-vm's own tests, the
harness supplies stand-ins: scratch-vm's `test/fixtures/fake-renderer.js` (with real
layering, `layered-fake-renderer.js`), `fake-bitmap-adapter.js`, and a mock
`Image`/canvas and audio engine that read each file's header. Whether pictures and
sounds look and sound right is the manual acceptance check in the portal's
`docs/guides/STAFF_GUIDE.md`.

## The fixtures

| File | Covers | Source |
|---|---|---|
| `blank.sb3` | the project the portal starts every child with | made by the portal |
| `category-motion.sb3`, `-looks`, `-sound`, `-events`, `-control`, `-sensing`, `-operators-and-data` | every core block category, variables and lists | scratch-vm `test/fixtures/*.sb2`, made in Scratch by the Scratch Team |
| `my-blocks.sb3` | My Blocks (custom procedures) | `procedure.sb2` |
| `clones.sb3` | clones | `clone-cleanup.sb2` |
| `broadcasts.sb3` | broadcasts, including special characters | `broadcast_special_chars.sb3` |
| `cloud-variable.sb3` | a cloud variable | `cloud_variables_simple.sb3` |
| `variables-and-lists-monitors.sb3` | variable, list and block monitors | `monitors.sb3` |
| `comments.sb3` | workspace and block comments | `comments.sb3` |
| `extension-pen.sb3`, `-music`, `-microbit` | each allowed extension | `load-extensions/confirm-load/*-simple-project.sb3` |
| `extension-makeymakey.sb3` | the Makey Makey extension, a PNG costume at bitmap resolution 1 | built by `make-sources.js` |
| `media-png-and-mp3.sb3` | PNG costume and MP3 sound (the others have SVG and WAV) | built by `make-sources.js` |
| `near-size-limits.sb3` | a project.json near 5 MB and a sound near 10 MB | built by `make-sources.js` |
| `from-scratch-mit-edu.sb3`, `from-scratch-default.sb3` | projects saved from scratch.mit.edu and the Scratch default project | `origin.sb3`, `default.sb3` |

Every fixture was downloaded from the portal's real
`GET /code/api/projects/<id>/export.sb3`. To make them again:

```sh
node test/compat/make-sources.js <sources-dir>
# then, in the PCA portal (its own virtual environment):
python scripts/make_code_compat_fixtures.py <sources-dir> <this repo>/test/compat/fixtures
```

`make-sources.js` loads each upstream project in scratch-vm and saves it as `.sb3`,
as the editor does when a child uses "Load from your computer" (sb2 files are
converted on the way), and builds the three projects no upstream fixture covers. The
portal script uploads each one as a signed-in student would, through the same API
the editor uses, then downloads it from the export endpoint. It runs the portal
in-process with a throwaway database; nothing is sent anywhere.
