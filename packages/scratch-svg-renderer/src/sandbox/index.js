// Support both CommonJS (Node / bundler) and plain browser <script> inclusion.
// In browser context, iframe-html.js must be loaded first via a <script> tag
// so that window.IFRAME_HTML is already defined before this script runs.
// The entire module body is wrapped in an IIFE, so that top-level `const`
// declarations don't collide with those in iframe-html.js when both scripts
// share a single browser page scope.
(function () {
    const IFRAME_HTML = typeof module === 'undefined' ?
        window.IFRAME_HTML :
        require('./iframe-html').IFRAME_HTML;

    const DEFAULT_TIMEOUT_MS = 30000;

    // PCA patch: a host page can name a URL that serves IFRAME_HTML with
    // <meta name="scratch-sandbox-frame-url" content="...">. A `srcdoc` iframe
    // inherits the host page's Content-Security-Policy, so a host page that
    // forbids inline scripts and eval cannot run the sandbox that way. With the
    // meta tag, the iframe loads the URL instead and runs under that response's
    // own policy, which must include `sandbox allow-scripts` so the page keeps
    // an opaque origin even if opened outside the iframe.

    /**
     * @returns {string|null} The sandbox frame URL named by the host page, if any.
     */
    const getFrameUrl = () => {
        if (typeof document === 'undefined') return null;
        const meta = document.querySelector('meta[name="scratch-sandbox-frame-url"]');
        return (meta && meta.content) || null;
    };

    /**
     * A sandboxed iframe that runs caller-provided scripts in an opaque-origin
     * context. The iframe uses `sandbox="allow-scripts"` without
     * `allow-same-origin`, giving it an opaque origin that cannot access the
     * parent's DOM, cookies, or storage. A strict Content-Security-Policy
     * (`default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'`) blocks
     * network requests and external resource loads.
     *
     * The iframe is lazily created on the first `send()` call and reused for
     * all subsequent calls until `destroy()` is called. After `destroy()`, the
     * next `send()` creates a fresh iframe.
     */
    class Sandbox {
    /**
     * @param {string} script JavaScript source that must synchronously
     *     define `window.onSandboxMessage = function (payload) { ... }`.
     *     The function receives a single structured-cloneable value and
     *     must return a result (or a Promise of a result).
     * @param {object} [options] Configuration options.
     * @param {number} [options.timeoutMs] Per-send timeout in
     *     milliseconds (default 30000). Set to 0 to disable.
     * @param {number} [options.idleTimeoutMs] If greater than 0, the iframe is
     *     destroyed after this many milliseconds with no in-flight calls; the
     *     next `send()` lazily creates a fresh one. Default 0 (never auto-destroy),
     *     which keeps the iframe alive for the lifetime of the page.
     */
        constructor (script, {timeoutMs = DEFAULT_TIMEOUT_MS, idleTimeoutMs = 0} = {}) {
            // Defensive copy so a caller mutating the original string after construction
            // doesn't affect a sandbox that has already been created but not yet sent.
            this._script = String(script);
            this._timeoutMs = timeoutMs;
            this._idleTimeoutMs = idleTimeoutMs;
            this._iframe = null;
            this._ready = null;
            this._onMessage = null;
            this._pendingTickets = new Map();
            this._scriptSent = false;
            this._nextTicket = 1;
            this._idleTimerId = null;
        }

        /**
         * Clear any pending idle-teardown timer.
         */
        _clearIdleTimer () {
            if (this._idleTimerId !== null) {
                clearTimeout(this._idleTimerId);
                this._idleTimerId = null;
            }
        }

        /**
         * Schedule destruction of the iframe after the idle window, but only
         * when idle teardown is enabled, an iframe exists, and no calls are in
         * flight. When it fires after a period of inactivity, the iframe is
         * destroyed; the next `send()` lazily recreates it.
         */
        _scheduleIdleTeardown () {
            this._clearIdleTimer();
            if (this._idleTimeoutMs > 0 && this._iframe && this._pendingTickets.size === 0) {
                this._idleTimerId = setTimeout(() => {
                    this._idleTimerId = null;
                    // A send may have started after the timer was armed; only
                    // tear down if still idle.
                    if (this._pendingTickets.size === 0) {
                        this.destroy();
                    }
                }, this._idleTimeoutMs);
            }
        }

        /**
         * Lazily create the sandboxed iframe and wait for it to load.
         * @returns {Promise<void>}
         */
        _ensureIframe () {
            if (this._ready) return this._ready;

            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-scripts');
            // Use visibility:hidden instead of display:none so the iframe's
            // rendering tree stays active. This is required for DOM
            // measurement APIs (e.g. getBBox) to return correct values.
            iframe.style.position = 'absolute';
            iframe.style.visibility = 'hidden';
            iframe.style.width = '0';
            iframe.style.height = '0';
            iframe.style.border = 'none';
            iframe.style.overflow = 'hidden';
            iframe.style.pointerEvents = 'none';
            this._iframe = iframe;

            this._onMessage = event => {
                // The sandboxed iframe (no allow-same-origin) always has an opaque origin,
                // reported as 'null'. Combined with the source check, this is defense-in-depth.
                if (event.origin !== 'null') return;
                if (event.source !== iframe.contentWindow) return;
                const data = event.data;
                if (!data || typeof data.__sandbox_ticket === 'undefined') return;

                const pending = this._pendingTickets.get(data.__sandbox_ticket);
                if (!pending) return;

                this._pendingTickets.delete(data.__sandbox_ticket);
                if (pending.timeoutId !== null) {
                    clearTimeout(pending.timeoutId);
                }

                if (typeof data.__sandbox_error === 'undefined') {
                    pending.resolve(data.__sandbox_result);
                } else {
                    pending.reject(new Error(data.__sandbox_error));
                }

                // The call settled; restart the idle countdown if nothing else
                // is in flight.
                this._scheduleIdleTeardown();
            };

            window.addEventListener('message', this._onMessage);

            this._ready = new Promise((resolve, reject) => {
                iframe.addEventListener('load', () => resolve());
                // The 'error' event on an iframe element is a generic Event, not
                // an ErrorEvent — it has no .message property. Use a static message.
                iframe.addEventListener('error', () => {
                    reject(new Error('Sandbox iframe failed to load'));
                });
            }).catch(error => {
                // Reset state so a subsequent send() can retry with a fresh iframe.
                this.destroy();
                throw error;
            });

            const url = getFrameUrl();
            if (url) {
                iframe.src = url;
            } else {
                iframe.srcdoc = IFRAME_HTML;
            }
            document.body.appendChild(iframe);

            return this._ready;
        }

        /**
         * Eagerly create the iframe and evaluate the caller's script so its
         * top-level setup (e.g. paper.setup, font decode) runs ahead of time.
         * The first subsequent `send()` then pays neither the iframe-load nor
         * the script-eval cost. Safe to call repeatedly and concurrently with
         * `send()`: it is a no-op once the script has been sent.
         * @returns {Promise<void>} Resolves once the iframe has acknowledged.
         */
        async warmUp () {
            if (this._scriptSent) return;
            await this.send(null, {warm: true});
        }

        /**
         * Send a payload to the iframe and return the result.
         *
         * The payload can be any structured-cloneable value. If you need to
         * process multiple items in a single round-trip, pass an array as the
         * payload and handle it in your `onSandboxMessage` function.
         * @param {object} payload The value to pass to onSandboxMessage.
         * @param {object} [options] Internal options.
         * @param {boolean} [options.warm] Send a warm-up message that only
         *     evaluates the script without invoking onSandboxMessage.
         * @returns {Promise<object>} The value returned by onSandboxMessage.
         */
        async send (payload, {warm = false} = {}) {
            // Activity: cancel any pending idle teardown so we never destroy the
            // iframe out from under an imminent send.
            this._clearIdleTimer();
            await this._ensureIframe();

            const ticket = this._nextTicket++;
            const message = warm ?
                {__sandbox_warm: true, __sandbox_ticket: ticket} :
                {__sandbox_payload: payload, __sandbox_ticket: ticket};

            if (!this._scriptSent) {
                message.__sandbox_script = this._script;
                this._scriptSent = true;
            }

            return new Promise((resolve, reject) => {
                let timeoutId = null;
                if (this._timeoutMs > 0) {
                    timeoutId = setTimeout(() => {
                        this._pendingTickets.delete(ticket);
                        reject(new Error(
                            `Sandbox: timed out after ${this._timeoutMs}ms`
                        ));
                        // The call settled (by timing out); restart the idle
                        // countdown if nothing else is in flight.
                        this._scheduleIdleTeardown();
                    }, this._timeoutMs);
                }

                this._pendingTickets.set(ticket, {resolve, reject, timeoutId});
                this._iframe.contentWindow.postMessage(message, '*');
            });
        }

        /**
         * Tear down the iframe and reject any in-flight calls.
         * After `destroy()`, the next `send()` lazily creates a fresh iframe.
         */
        destroy () {
            this._clearIdleTimer();
            for (const pending of this._pendingTickets.values()) {
                if (pending.timeoutId !== null) {
                    clearTimeout(pending.timeoutId);
                }
                pending.reject(new Error('Sandbox destroyed'));
            }
            this._pendingTickets.clear();

            if (this._onMessage) {
                window.removeEventListener('message', this._onMessage);
                this._onMessage = null;
            }

            if (this._iframe && this._iframe.parentNode) {
                this._iframe.parentNode.removeChild(this._iframe);
            }
            this._iframe = null;
            this._ready = null;
            this._scriptSent = false;
        }
    }

    if (typeof module === 'undefined') {
        window.Sandbox = Sandbox;
    } else {
        module.exports = {Sandbox};
    }
}()); // end IIFE
