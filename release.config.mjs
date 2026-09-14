// semantic-release expands `${...}` in its own template syntax, so plain strings
// here use those references intentionally — the lint rule is off for this file:
/* eslint-disable no-template-curly-in-string */

// No @semantic-release/npm: per-package publishing stays in the cd job.
// No @semantic-release/github: the GitHub release is created by the finalize
// job, using the commit body as the release notes.

import {commitPartial, commitsSort, finalizeContext} from './scripts/release-notes-writer-opts.mjs';

// semantic-release template: strips the matched branch's prefix from ${name},
// keeping channel and prerelease identifier free of '/' (npm dist-tags and
// semver prerelease identifiers both forbid it).
const stripPrefix = (prefix) => `\${name.replace(/^${prefix}\\//, "")}`;

export default {
    branches: [
        'develop',
        '+([0-9])?(.{+([0-9]),x}).x',
        { name: 'release/*', channel: stripPrefix('release'), prerelease: stripPrefix('release') },
        { name: 'hotfix/*', channel: stripPrefix('hotfix'), prerelease: stripPrefix('hotfix') }
    ],
    plugins: [
        '@semantic-release/commit-analyzer',
        ['@semantic-release/release-notes-generator', { writerOpts: {commitPartial, commitsSort, finalizeContext} }],
        [
            '@semantic-release/exec',
            {
                prepareCmd: 'npm version "${nextRelease.version}" --no-git-tag-version',
                publishCmd: 'printf "%s" "${nextRelease.version}" > .release-version && printf "%s" "${nextRelease.channel || \'\'}" > .release-channel'
            }
        ],
        [
            '@semantic-release/git',
            {
                assets: [
                    'package.json',
                    'package-lock.json',
                    'packages/*/package.json'
                ],
                // git commit -m passes the message as a single argv, which the kernel caps at
                // MAX_ARG_STRLEN (131072 bytes on Linux, including the terminating NUL). Releases
                // with very large notes overflow that and fail with E2BIG. Truncate the notes to
                // 120000 bytes, leaving headroom for the header.
                message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${Buffer.from(nextRelease.notes).toString("utf8", 0, 120000)}'
            }
        ]
    ]
};
