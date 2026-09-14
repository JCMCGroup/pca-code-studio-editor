// PCA patch: everything the PCA editor page adds around upstream's GUI.
//
// - Autosave 30 seconds after the last change, on "Save now", when the tab is
//   hidden, and again after a failed save (backing off while offline).
// - A status pill: Saved / Saving… / Unsaved changes / Not saved – check your
//   connection.
// - A recovery copy in IndexedDB, and "Restore unsaved work" when one exists.
// - Signed out (401): keep everything, say so, let the child sign in again in
//   another tab and try once more. Never navigate away.
// - Conflict (409): save as a copy, or load the newer version.
// - A refused costume or sound is named.
// - Read-only banner for staff and parents; the About dialog with attribution
//   and the AGPL source offer.
//
// Upstream's own save alerts are switched off through props its HOCs accept.

import PropTypes from 'prop-types';
import React from 'react';
import ReactModal from 'react-modal';
import {connect} from 'react-redux';

import {setProjectChanged} from '../../reducers/project-changed';
import {
    LoadingState,
    autoUpdateProject,
    getIsShowingWithId,
    manualUpdateProject,
    projectError,
    saveProjectAsCopy
} from '../../reducers/project-state';
import {getPcaRuntime, setPcaHooks} from './runtime';
import {deleteRecovery, expireRecovery, readRecovery, writeRecovery} from './recovery';

import styles from './pca-editor.css';

const UPDATING = [
    LoadingState.AUTO_UPDATING,
    LoadingState.MANUAL_UPDATING,
    LoadingState.CREATING_COPY,
    LoadingState.UPDATING_BEFORE_COPY
];
const RECOVERY_DELAY_MS = 4000;
const RETRY_STEPS_MS = [30000, 60000, 120000, 300000];
const TITLE_DELAY_MS = 1000;
const DOWNLOAD_SAVE_TIMEOUT_MS = 60000;

const noop = () => {};

const formatTime = timestamp => new Date(timestamp).toLocaleString('en-GB', {
    weekday: 'long', hour: '2-digit', minute: '2-digit'
});

const Dialog = ({title, children, actions, onClose}) => (
    <ReactModal
        isOpen
        className={styles.dialog}
        overlayClassName={styles.overlay}
        contentLabel={title}
        shouldCloseOnOverlayClick={false}
        onRequestClose={onClose || noop}
    >
        <h2 className={styles.dialogTitle}>{title}</h2>
        <div className={styles.dialogBody}>{children}</div>
        <div className={styles.dialogActions}>{actions}</div>
    </ReactModal>
);

Dialog.propTypes = {
    actions: PropTypes.node,
    children: PropTypes.node,
    onClose: PropTypes.func,
    title: PropTypes.string.isRequired
};

const PcaEditorHOC = function (WrappedComponent) {
    class PcaEditor extends React.Component {
        constructor (props) {
            super(props);
            this.runtime = getPcaRuntime();
            this.changeCount = 0;
            this.changeCountAtSave = 0;
            this.retryStep = 0;
            this.timers = {};
            this.shownAssetErrors = new Set();
            this.state = {
                error: null,
                dialog: null,
                recovery: null,
                about: false,
                toast: null
            };
            [
                'handleProjectChanged', 'handleStorageEvent', 'handleVisibility', 'handleOnline',
                'handleLoadError', 'handleTitle', 'handleSaveNow', 'handleSignIn', 'handleRetry',
                'handleSaveCopy', 'handleLoadNewer', 'handleRestore', 'handleDiscardRecovery',
                'handleSaveTemplate', 'handleOpenAbout', 'handleCloseDialog', 'handleLogo',
                'handleSaveToComputer', 'handleBeginImport', 'handleImportProject', 'handleImportFailed',
                'handleBackToProject'
            ].forEach(name => {
                this[name] = this[name].bind(this);
            });
        }

        componentDidMount () {
            this.unsubscribe = this.props.storage.subscribe(this.handleStorageEvent);
            this.props.vm.on('PROJECT_CHANGED', this.handleProjectChanged);
            document.addEventListener('visibilitychange', this.handleVisibility);
            window.addEventListener('online', this.handleOnline);
            if (this.canSave()) expireRecovery().catch(noop);
            setPcaHooks(this.canSave() ? {
                saveToComputer: this.handleSaveToComputer,
                beginImport: this.handleBeginImport,
                importProject: this.handleImportProject,
                importFailed: this.handleImportFailed
            } : {saveToComputer: this.handleSaveToComputer});
        }

        componentDidUpdate (prevProps) {
            const wasUpdating = UPDATING.includes(prevProps.loadingState);
            const isUpdating = UPDATING.includes(this.props.loadingState);
            if (isUpdating && !wasUpdating) this.changeCountAtSave = this.changeCount;
            if (this.props.isShowingWithId && !prevProps.isShowingWithId && !this.checkedRecovery) {
                this.checkedRecovery = true;
                this.checkRecovery();
            }
        }

        componentWillUnmount () {
            if (this.unsubscribe) this.unsubscribe();
            this.props.vm.removeListener('PROJECT_CHANGED', this.handleProjectChanged);
            document.removeEventListener('visibilitychange', this.handleVisibility);
            window.removeEventListener('online', this.handleOnline);
            Object.values(this.timers).forEach(clearTimeout);
            setPcaHooks({});
        }

        canSave () {
            return this.runtime.mode === 'edit' && this.runtime.permissions.canSave;
        }

        schedule (name, delay, fn) {
            clearTimeout(this.timers[name]);
            this.timers[name] = setTimeout(() => fn(), delay);
        }

        blocked () {
            const dialog = this.state.dialog;
            return Boolean(dialog && (dialog.kind === 'signedOut' || dialog.kind === 'conflict'));
        }

        autosaveNow () {
            if (!this.canSave() || this.blocked() || this.props.storage.importing) return;
            if (this.props.isShowingWithId && this.props.projectChanged) this.props.onAutoUpdateProject();
        }

        // -- changes and saving ------------------------------------------
        handleProjectChanged () {
            if (!this.canSave() || this.props.storage.importing) return;
            this.changeCount += 1;
            this.schedule('autosave', this.runtime.autosaveSeconds * 1000, () => this.autosaveNow());
            this.schedule('recovery', RECOVERY_DELAY_MS, () => this.writeRecoveryNow());
        }

        handleVisibility () {
            if (document.visibilityState !== 'hidden' || !this.props.projectChanged) return;
            this.writeRecoveryNow();
            this.autosaveNow();
        }

        handleOnline () {
            if (this.state.error && this.state.error.kind === 'offline') this.autosaveNow();
        }

        handleSaveNow () {
            if (this.props.storage.importing) return;
            if (this.props.isShowingWithId) this.props.onManualUpdateProject();
        }

        // -- files on the computer ---------------------------------------
        saveAndWait () {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    unsubscribe();
                    reject({kind: 'error', message: 'Saving took too long.'});
                }, DOWNLOAD_SAVE_TIMEOUT_MS);
                const unsubscribe = this.props.storage.subscribe(event => {
                    if (event.type !== 'saved' && event.type !== 'error') return;
                    clearTimeout(timer);
                    unsubscribe();
                    if (event.type === 'saved') resolve();
                    else reject(event.error);
                });
                if (!UPDATING.includes(this.props.loadingState)) this.props.onManualUpdateProject();
            });
        }

        handleSaveToComputer () {
            const needsSave = this.canSave() &&
                (this.props.projectChanged || UPDATING.includes(this.props.loadingState));
            (needsSave ? this.saveAndWait() : Promise.resolve())
                .then(() => {
                    const link = document.createElement('a');
                    link.href = this.runtime.api.export;
                    link.download = '';
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                })
                .catch(error => {
                    if (error && (error.kind === 'signedOut' || error.kind === 'conflict')) return;
                    this.setState({dialog: {
                        kind: 'message',
                        title: 'Not downloaded yet',
                        text: `Your project needs to be saved before it can be downloaded. ${
                            (error && error.message) || ''}`.trim()
                    }});
                });
        }

        handleBeginImport () {
            this.props.storage.importing = true;
            ['autosave', 'recovery', 'retry', 'title'].forEach(name => clearTimeout(this.timers[name]));
        }

        handleImportProject (title) {
            this.setState({dialog: {kind: 'importing'}});
            this.props.storage.importAsNewProject(title)
                .then(publicId => {
                    window.onbeforeunload = null;
                    window.location.assign(this.runtime.urls.editor.replace(this.runtime.project.id, publicId));
                })
                .catch(error => {
                    const described = error.described || {message: error.message};
                    this.handleImportFailed(described.message);
                });
        }

        handleImportFailed (message) {
            this.setState({dialog: {kind: 'importFailed', text: message}});
        }

        handleBackToProject () {
            window.onbeforeunload = null;
            window.location.reload();
        }

        handleStorageEvent (event) {
            if (event.type === 'saved') {
                this.retryStep = 0;
                this.setState({error: null});
                if (this.changeCount === this.changeCountAtSave) {
                    deleteRecovery(this.runtime.project.id).catch(noop);
                }
                return;
            }
            if (event.type === 'copied') {
                window.onbeforeunload = null;
                window.location.assign(this.runtime.urls.editor.replace(this.runtime.project.id, event.id));
                return;
            }
            if (event.type === 'loadError') {
                if (event.error.kind === 'signedOut') this.setState({dialog: {kind: 'signedOut', onLoad: true}});
                return;
            }
            if (event.type !== 'error') return;
            const error = event.error;
            this.setState({error});
            if (error.kind === 'signedOut') {
                this.setState({dialog: {kind: 'signedOut'}});
            } else if (error.kind === 'conflict') {
                this.setState({dialog: {kind: 'conflict'}});
            } else if (error.kind === 'asset' && !this.shownAssetErrors.has(error.md5ext)) {
                this.shownAssetErrors.add(error.md5ext);
                this.setState({dialog: {kind: 'message', title: 'Something could not be saved', text: error.message}});
            } else if (error.kind === 'quota' || error.kind === 'tooBig') {
                this.setState({dialog: {kind: 'message', title: 'Your project was not saved', text: error.message}});
            }
            if (!['signedOut', 'conflict'].includes(error.kind)) {
                const delay = RETRY_STEPS_MS[Math.min(this.retryStep, RETRY_STEPS_MS.length - 1)];
                this.retryStep += 1;
                this.schedule('retry', delay, () => this.autosaveNow());
            }
        }

        handleLoadError (error) {
            if (error && error.isSignedOut) return; // the storage event shows the dialog
            this.props.onProjectError(error);
        }

        handleTitle (title) {
            if (!this.canSave()) return;
            this.schedule('title', TITLE_DELAY_MS, () => {
                this.props.storage.api.updateMeta({title}).catch(error => {
                    if (error && error.isSignedOut) this.setState({dialog: {kind: 'signedOut'}});
                });
            });
        }

        // -- recovery ----------------------------------------------------
        writeRecoveryNow () {
            if (!this.canSave() || !this.props.projectChanged) return;
            const changeCount = this.changeCount;
            this.props.vm.saveProjectSb3()
                .then(sb3 => writeRecovery({
                    projectId: this.runtime.project.id,
                    savedAt: Date.now(),
                    baseVersion: this.props.storage.version,
                    changeCount,
                    sb3
                }))
                .catch(noop);
        }

        checkRecovery () {
            if (!this.canSave()) return;
            readRecovery(this.runtime.project.id).then(record => {
                if (!record || !record.sb3) return;
                const serverSaved = this.runtime.project.lastSavedAt ?
                    Date.parse(this.runtime.project.lastSavedAt) : 0;
                this.setState({
                    recovery: record,
                    dialog: {kind: 'recovery', olderThanServer: record.savedAt < serverSaved}
                });
            })
                .catch(noop);
        }

        handleRestore () {
            const record = this.state.recovery;
            this.setState({dialog: null, recovery: null});
            record.sb3.arrayBuffer()
                .then(buffer => this.props.vm.loadProject(buffer))
                .then(() => {
                    this.props.onSetProjectChanged();
                    this.handleProjectChanged();
                })
                .catch(() => {
                    this.setState({dialog: {
                        kind: 'message',
                        title: 'That did not work',
                        text: 'The unsaved work could not be opened. It has been kept on this computer.'
                    }});
                });
        }

        handleDiscardRecovery () {
            deleteRecovery(this.runtime.project.id).catch(noop);
            this.setState({dialog: null, recovery: null});
        }

        // -- dialogs -----------------------------------------------------
        handleSignIn () {
            window.open(this.runtime.urls.signIn, '_blank', 'noopener');
        }

        handleRetry () {
            const onLoad = this.state.dialog && this.state.dialog.onLoad;
            this.setState({dialog: null});
            if (onLoad) {
                window.location.reload();
                return;
            }
            this.retryStep = 0;
            this.handleSaveNow();
        }

        handleSaveCopy () {
            this.setState({dialog: null});
            this.props.onSaveAsCopy();
        }

        handleLoadNewer () {
            deleteRecovery(this.runtime.project.id).catch(noop);
            window.onbeforeunload = null;
            window.location.reload();
        }

        handleSaveTemplate () {
            this.props.storage.api.saveAsTemplate()
                .then(template => this.setState({toast: `Saved as “${template.title}” in your templates.`}))
                .catch(error => this.setState({toast: error.message || 'That could not be saved.'}));
        }

        handleOpenAbout () {
            this.setState({about: true});
        }

        handleCloseDialog () {
            this.setState({dialog: null, about: false});
        }

        handleLogo () {
            window.location.assign(this.runtime.urls.home);
        }

        // -- rendering ---------------------------------------------------
        renderPill () {
            if (!this.canSave()) return null;
            let text = 'Saved';
            let tone = styles.pillSaved;
            let action = null;
            if (UPDATING.includes(this.props.loadingState)) {
                text = 'Saving…';
                tone = styles.pillSaving;
            } else if (this.state.error && this.props.projectChanged) {
                text = this.state.error.kind === 'offline' ? 'Not saved – check your connection' : 'Not saved';
                tone = styles.pillError;
                action = this.handleSaveNow;
            } else if (this.props.projectChanged) {
                text = 'Unsaved changes';
                tone = styles.pillPending;
                action = this.handleSaveNow;
            }
            return (
                <button
                    type="button"
                    className={`${styles.pill} ${tone}`}
                    onClick={action || noop}
                    disabled={!action}
                    title={action ? 'Save now' : null}
                    aria-live="polite"
                >
                    {text}
                </button>
            );
        }

        renderDialog () {
            const dialog = this.state.dialog;
            if (this.state.about) {
                const about = this.runtime.about;
                return (
                    <Dialog
                        title={`About ${about.name}`}
                        onClose={this.handleCloseDialog}
                        actions={<button
                            className={styles.primary}
                            onClick={this.handleCloseDialog}
                        >Close</button>}
                    >
                        <p>{about.attribution}.</p>
                        <p>
                            {about.name} is free software: you can use, study, share and change it under the
                            GNU Affero General Public License, version 3.
                        </p>
                        {about.sourceUrl ? (
                            <p>
                                <a
                                    href={about.sourceUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    Get the source code of this editor
                                </a>
                            </p>
                        ) : null}
                        <p className={styles.small}>
                            Build {about.buildId} ({about.upstreamVersion})
                        </p>
                    </Dialog>
                );
            }
            if (!dialog) return null;
            if (dialog.kind === 'signedOut') {
                return (
                    <Dialog
                        title="You’ve been signed out"
                        actions={[
                            <button
                                key="in"
                                className={styles.secondary}
                                onClick={this.handleSignIn}
                            >
                                Open the sign-in page
                            </button>,
                            <button
                                key="retry"
                                className={styles.primary}
                                onClick={this.handleRetry}
                            >
                                {dialog.onLoad ? 'I’ve signed in – try again' : 'I’ve signed in – save now'}
                            </button>
                        ]}
                    >
                        <p>Ask your club leader to help you sign in again.</p>
                        {dialog.onLoad ? null : (
                            <p>Your work is still here. Don’t close this page.</p>
                        )}
                    </Dialog>
                );
            }
            if (dialog.kind === 'importing') {
                return (
                    <Dialog title="Adding your file">
                        <p>Making it into a new project…</p>
                    </Dialog>
                );
            }
            if (dialog.kind === 'importFailed') {
                return (
                    <Dialog
                        title="That file couldn’t be added"
                        actions={
                            <button
                                className={styles.primary}
                                onClick={this.handleBackToProject}
                            >
                                {`Back to “${this.runtime.project.title}”`}
                            </button>
                        }
                    >
                        <p>{dialog.text}</p>
                        <p>None of your projects have changed.</p>
                    </Dialog>
                );
            }
            if (dialog.kind === 'conflict') {
                return (
                    <Dialog
                        title="This project was changed somewhere else"
                        actions={[
                            <button
                                key="newer"
                                className={styles.secondary}
                                onClick={this.handleLoadNewer}
                            >
                                Load the newer version
                            </button>,
                            <button
                                key="copy"
                                className={styles.primary}
                                onClick={this.handleSaveCopy}
                            >
                                Save as a copy
                            </button>
                        ]}
                    >
                        <p>It was saved in another tab or on another computer after you opened it.</p>
                        <p>
                            <strong>Save as a copy</strong> keeps your changes as a new project.{' '}
                            <strong>Load the newer version</strong> replaces what is on this screen.
                        </p>
                    </Dialog>
                );
            }
            if (dialog.kind === 'recovery') {
                const record = this.state.recovery;
                return (
                    <Dialog
                        title="Restore unsaved work?"
                        actions={[
                            <button
                                key="keep"
                                className={styles.secondary}
                                onClick={this.handleDiscardRecovery}
                            >
                                Keep the saved version
                            </button>,
                            <button
                                key="restore"
                                className={styles.primary}
                                onClick={this.handleRestore}
                            >
                                Restore unsaved work
                            </button>
                        ]}
                    >
                        <p>
                            This computer has changes to this project from {formatTime(record.savedAt)} that were
                            never saved.
                        </p>
                        {dialog.olderThanServer ? (
                            <p>A newer version has been saved since then, somewhere else.</p>
                        ) : null}
                    </Dialog>
                );
            }
            return (
                <Dialog
                    title={dialog.title}
                    onClose={this.handleCloseDialog}
                    actions={<button
                        className={styles.primary}
                        onClick={this.handleCloseDialog}
                    >OK</button>}
                >
                    <p>{dialog.text}</p>
                </Dialog>
            );
        }

        render () {
            const {
                /* eslint-disable @typescript-eslint/no-unused-vars */
                isShowingWithId,
                loadingState,
                onAutoUpdateProject,
                onManualUpdateProject,
                onProjectError,
                onSaveAsCopy,
                onSetProjectChanged,
                projectChanged,
                storage,
                /* eslint-enable @typescript-eslint/no-unused-vars */
                ...guiProps
            } = this.props;
            const readOnly = this.runtime.mode === 'readonly';
            return (
                <div className={readOnly ? `${styles.root} ${styles.withBanner}` : styles.root}>
                    {readOnly ? (
                        <div
                            className={styles.banner}
                            role="status"
                        >
                            <span>
                                Viewing {this.runtime.project.ownerLabel}’s project – changes are not saved
                            </span>
                            {this.runtime.permissions.canSaveTemplate ? (
                                <button
                                    className={styles.bannerButton}
                                    onClick={this.handleSaveTemplate}
                                >
                                    Save a copy to my templates
                                </button>
                            ) : null}
                            {this.state.toast ? <span className={styles.toast}>{this.state.toast}</span> : null}
                        </div>
                    ) : null}
                    <div className={styles.gui}>
                        <WrappedComponent
                            {...guiProps}
                            projectTitle={this.runtime.project.title}
                            onUpdateProjectTitle={this.handleTitle}
                            onError={this.handleLoadError}
                            onClickLogo={this.handleLogo}
                            onClickAbout={[{title: `About ${this.runtime.about.name}`, onClick: this.handleOpenAbout}]}
                            onShowAlert={noop}
                            onShowSavingAlert={noop}
                            onShowSaveSuccessAlert={noop}
                            onShowCreatingCopyAlert={noop}
                            onShowCopySuccessAlert={noop}
                        />
                    </div>
                    {this.renderPill()}
                    {this.renderDialog()}
                </div>
            );
        }
    }

    PcaEditor.propTypes = {
        isShowingWithId: PropTypes.bool,
        loadingState: PropTypes.string,
        onAutoUpdateProject: PropTypes.func.isRequired,
        onManualUpdateProject: PropTypes.func.isRequired,
        onProjectError: PropTypes.func.isRequired,
        onSaveAsCopy: PropTypes.func.isRequired,
        onSetProjectChanged: PropTypes.func.isRequired,
        projectChanged: PropTypes.bool,
        storage: PropTypes.shape({
            api: PropTypes.object,
            importAsNewProject: PropTypes.func,
            importing: PropTypes.bool,
            subscribe: PropTypes.func,
            version: PropTypes.number
        }).isRequired,
        vm: PropTypes.shape({
            loadProject: PropTypes.func,
            on: PropTypes.func,
            removeListener: PropTypes.func,
            saveProjectSb3: PropTypes.func
        }).isRequired
    };

    const mapStateToProps = state => ({
        isShowingWithId: getIsShowingWithId(state.scratchGui.projectState.loadingState),
        loadingState: state.scratchGui.projectState.loadingState,
        projectChanged: state.scratchGui.projectChanged,
        storage: state.scratchGui.config.storage,
        vm: state.scratchGui.vm
    });

    const mapDispatchToProps = dispatch => ({
        onAutoUpdateProject: () => dispatch(autoUpdateProject()),
        onManualUpdateProject: () => dispatch(manualUpdateProject()),
        onProjectError: error => dispatch(projectError(error)),
        onSaveAsCopy: () => dispatch(saveProjectAsCopy()),
        onSetProjectChanged: () => dispatch(setProjectChanged())
    });

    return connect(mapStateToProps, mapDispatchToProps)(PcaEditor);
};

export default PcaEditorHOC;
