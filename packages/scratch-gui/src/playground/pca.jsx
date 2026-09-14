// PCA patch: the entry point for PCA Code Studio pages.
//
// The host page supplies everything in <script type="application/json"
// id="pca-editor-config"> (read, never executed) and a CSRF token in
// <meta name="csrf-token">. Modes:
//   edit     - the owner edits; saves go to the portal
//   readonly - staff or parents look; nothing is saved
//   player   - green flag, stop and full screen only

// Polyfills, as in the upstream playground.
import 'es6-object-assign/auto';
import 'core-js/fn/array/includes';
import 'core-js/fn/promise/finally';
import 'intl';

import React from 'react';
import ReactDomClient from 'react-dom/client';

import AppStateHOC from '../lib/app-state-hoc.jsx';
import BrowserModalComponent from '../components/browser-modal/browser-modal.jsx';
import supportedBrowser from '../lib/supported-browser';
import {setPcaRuntime} from '../lib/pca/runtime';

import styles from './index.css';

const readConfig = () => {
    const element = document.getElementById('pca-editor-config');
    return element ? JSON.parse(element.textContent) : null;
};

const isPhone = () => (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 599px) and (pointer: coarse)').matches
);

const config = readConfig();
setPcaRuntime(config);
const appTarget = document.createElement('div');
appTarget.className = styles.app;

if (!config) {
    document.body.appendChild(document.createTextNode('This page is missing its editor settings.'));
} else if (config.mode !== 'player' && isPhone()) {
    const notice = document.getElementById('pca-phone-notice');
    if (notice) notice.hidden = false;
} else if (supportedBrowser()) {
    document.body.appendChild(appTarget);
    // required here so unsupported browsers never evaluate the editor
    require('./render-pca.jsx').default(appTarget, config);
} else {
    document.body.appendChild(appTarget);
    BrowserModalComponent.setAppElement(appTarget);
    const WrappedBrowserModalComponent = AppStateHOC(BrowserModalComponent, true /* localesOnly */);
    const root = ReactDomClient.createRoot(appTarget);
    const handleBack = () => {
        window.location.assign(config.urls.home);
    };
    // eslint-disable-next-line react/jsx-no-bind
    root.render(<WrappedBrowserModalComponent onBack={handleBack} />);
}
