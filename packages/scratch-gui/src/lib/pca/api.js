// PCA patch: calls to the host portal's Code Studio API.
//
// Same-origin requests with the session cookie. Every write carries the CSRF
// token from <meta name="csrf-token">; if the portal says the token has gone
// stale on a live session, a fresh one is fetched once and the request retried.

/**
 * An API refusal the editor can act on.
 */
export class PcaApiError extends Error {
    /**
     * @param {number} status HTTP status, or 0 when the request never arrived.
     * @param {object} body the JSON error body, when there was one.
     */
    constructor (status, body) {
        super((body && body.message) || (status ? `Request failed (${status})` : 'Network error'));
        this.name = 'PcaApiError';
        this.status = status;
        this.code = (body && body.error) || (status ? 'error' : 'offline');
        this.body = body || {};
    }

    get isOffline () {
        return this.status === 0;
    }

    get isSignedOut () {
        return this.status === 401;
    }

    get isConflict () {
        return this.status === 409;
    }
}

const readToken = () => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
};

const writeToken = token => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && token) meta.setAttribute('content', token);
};

const parseBody = async response => {
    const type = response.headers.get('Content-Type') || '';
    if (!type.includes('application/json')) return null;
    try {
        return await response.json();
    } catch {
        return null;
    }
};

export class PcaApi {
    /**
     * @param {object} config the page config's `api` block.
     */
    constructor (config) {
        this.urls = config;
    }

    async refreshToken () {
        const response = await fetch(this.urls.session, {
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (response.status === 401) throw new PcaApiError(401, await parseBody(response));
        if (!response.ok) throw new PcaApiError(response.status, await parseBody(response));
        const body = await response.json();
        writeToken(body.csrf_token);
    }

    /**
     * @param {string} method HTTP method.
     * @param {string} url same-origin URL.
     * @param {object} [options] body, contentType, retried.
     * @returns {Promise<Response>} the successful response.
     */
    async request (method, url, {body, contentType, retried = false} = {}) {
        const headers = {};
        if (method !== 'GET' && method !== 'HEAD') headers['X-CSRFToken'] = readToken();
        if (contentType) headers['Content-Type'] = contentType;
        let response;
        try {
            response = await fetch(url, {
                method,
                body,
                headers,
                credentials: 'same-origin',
                cache: 'no-store'
            });
        } catch {
            throw new PcaApiError(0, null);
        }
        if (response.ok) return response;
        const errorBody = await parseBody(response);
        if (response.status === 400 && errorBody && errorBody.error === 'csrf' && !retried) {
            await this.refreshToken();
            return this.request(method, url, {body, contentType, retried: true});
        }
        throw new PcaApiError(response.status, errorBody);
    }

    async loadProject () {
        const response = await this.request('GET', this.urls.project);
        const version = parseInt(response.headers.get('X-Project-Version'), 10);
        return {data: new Uint8Array(await response.arrayBuffer()), version};
    }

    async saveProject (vmState, baseVersion, autosave) {
        const url = `${this.urls.project}?base_version=${encodeURIComponent(baseVersion)}` +
            `&autosave=${autosave ? 1 : 0}`;
        const response = await this.request('PUT', url, {body: vmState, contentType: 'application/json'});
        return response.json();
    }

    async createProject (vmState, title) {
        const url = `${this.urls.createProject}?title=${encodeURIComponent(title || '')}`;
        const response = await this.request('POST', url, {body: vmState, contentType: 'application/json'});
        return response.json();
    }

    async uploadAsset (md5ext, data) {
        const response = await this.request('PUT', `${this.urls.assets}${md5ext}`, {
            body: data,
            contentType: 'application/octet-stream'
        });
        return response.json();
    }

    async saveThumbnail (blob) {
        await this.request('PUT', this.urls.thumbnail, {body: blob, contentType: 'image/png'});
    }

    async updateMeta (changes) {
        const response = await this.request('PATCH', this.urls.meta, {
            body: JSON.stringify(changes),
            contentType: 'application/json'
        });
        return response.json();
    }

    async saveAsTemplate () {
        const response = await this.request('POST', this.urls.template);
        return response.json();
    }
}
