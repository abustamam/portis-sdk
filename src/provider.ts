import { Payload, Network } from "./types";
import { isMobile, isLocalhost, randomId } from "./utils";
import { css } from './style';

const sdkVersion = '1.2.9';
const postMessages = {
    PT_RESPONSE: 'PT_RESPONSE',
    PT_HANDLE_REQUEST: 'PT_HANDLE_REQUEST',
    PT_GREEN_LIGHT: 'PT_GREEN_LIGHT',
    PT_SHOW_IFRAME: 'PT_SHOW_IFRAME',
    PT_HIDE_IFRAME: 'PT_HIDE_IFRAME',
    PT_USER_DENIED: 'PT_USER_DENIED',
    PT_USER_LOGGED_IN: 'PT_USER_LOGGED_IN',
};
const portisPayloadMethods = {
    SET_DEFAULT_EMAIL: 'SET_DEFAULT_EMAIL',
    SHOW_PORTIS: 'SHOW_PORTIS',
};

export class PortisProvider {
    portisClient = 'https://app.portis.io';
    requests: { [id: string]: { payload: Payload, cb } } = {};
    queue: { payload: Payload, cb }[] = [];
    elements: Promise<{ wrapper: HTMLDivElement, iframe: HTMLIFrameElement }>;
    iframeReady: boolean;
    account: string | null = null;
    network: string | null = null;
    isPortis = true;
    referrerAppOptions;
    events: { eventName: string, callback }[] = [];

    constructor(opts: { apiKey: string, network?: Network, infuraApiKey?: string, providerNodeUrl?: string }) {
        if (!isLocalhost() && !opts.apiKey) {
            throw 'apiKey is missing. Please check your apiKey in the Portis dashboard: https://app.portis.io/dashboard';
        }

        if (opts.infuraApiKey && opts.providerNodeUrl) {
            throw 'Invalid parameters. \'infuraApiKey\' and \'providerNodeUrl\' cannot be both provided. Refer to the Portis documentation for more info.';
        }

        this.referrerAppOptions = {
            sdkVersion,
            network: opts.network || 'mainnet',
            apiKey: opts.apiKey,
            infuraApiKey: opts.infuraApiKey,
            providerNodeUrl: opts.providerNodeUrl,
        };
        this.elements = this.createIframe();
        this.listen();
    }

    sendAsync(payload: Payload, cb) {
        this.enqueue(payload, cb);
    }

    send(payload: Payload) {
        let result;

        switch (payload.method) {

            case 'eth_accounts':
                const account = this.account;
                result = account ? [account] : [];
                break;

            case 'eth_coinbase':
                result = this.account;
                break;

            case 'net_version':
                result = this.network;
                break;

            case 'eth_uninstallFilter':
                this.sendAsync(payload, (_) => _);
                result = true;
                break;

            default:
                throw new Error(`The Portis Web3 object does not support synchronous methods like ${payload.method} without a callback parameter.`);
        }

        return {
            id: payload.id,
            jsonrpc: payload.jsonrpc,
            result: result,
        }
    }

    isConnected() {
        return true;
    }

    setDefaultEmail(email: string) {
        this.sendGenericPayload(portisPayloadMethods.SET_DEFAULT_EMAIL, [email]);
    }

    showPortis(callback) {
        this.sendGenericPayload(portisPayloadMethods.SHOW_PORTIS, [], callback);
    }

    on(eventName: string, callback) {
        this.events.push({ eventName, callback });
    }

    private sendGenericPayload(method: string, params: any[] = [], callback = _ => _) {
        const payload = {
            id: randomId(),
            jsonrpc: '2.0',
            method,
            params,
        };
        this.enqueue(payload, callback);
    }

    private createIframe(): Promise<{ wrapper: HTMLDivElement, iframe: HTMLIFrameElement }> {
        return new Promise((resolve, reject) => {
            const onload = () => {
                const wrapper = document.createElement('div');
                const iframe = document.createElement('iframe');
                const styleElem = document.createElement('style');
                const mobile = isMobile();

                wrapper.className = mobile ? 'mobile-wrapper' : 'wrapper';
                iframe.className = mobile ? 'mobile-iframe' : 'iframe';
                iframe.src = `${this.portisClient}/send/?p=${btoa(JSON.stringify(this.referrerAppOptions))}`;
                styleElem.innerHTML = css;

                wrapper.appendChild(iframe);
                document.body.appendChild(wrapper);
                document.head.appendChild(styleElem);

                resolve({ wrapper, iframe });
            }

            if (['loaded', 'interactive', 'complete'].indexOf(document.readyState) > -1) {
                onload();
            } else {
                window.addEventListener('load', onload.bind(this), false);
            }
        });
    }

    private showIframe() {
        this.elements.then(elements => {
            elements.wrapper.style.display = 'block'

            if (isMobile()) {
                document.body.style.overflow = 'hidden';
            }
        });
    }

    private hideIframe() {
        this.elements.then(elements => {
            elements.wrapper.style.display = 'none';

            if (isMobile()) {
                document.body.style.overflow = 'inherit';
            }
        });
    }

    private enqueue(payload: Payload, cb) {
        this.queue.push({ payload, cb });

        if (this.iframeReady) {
            this.dequeue();
        }
    }

    private dequeue() {
        if (this.queue.length == 0) {
            return;
        }

        const item = this.queue.shift();

        if (item) {
            const payload = item.payload;
            const cb = item.cb;
            this.sendPostMessage(postMessages.PT_HANDLE_REQUEST, payload);
            this.requests[payload.id] = { payload, cb };
            this.dequeue();
        }
    }

    private sendPostMessage(msgType: string, payload?: Object) {
        this.elements.then(elements => {
            if (elements.iframe.contentWindow) {
                elements.iframe.contentWindow.postMessage({ msgType, payload }, '*');
            }
        });
    }

    private listen() {
        window.addEventListener('message', (evt) => {
            if (evt.origin === this.portisClient) {
                switch (evt.data.msgType) {

                    case postMessages.PT_GREEN_LIGHT: {
                        this.iframeReady = true;
                        this.dequeue();
                        break;
                    }

                    case postMessages.PT_RESPONSE: {
                        const id = evt.data.response.id;
                        this.requests[id].cb(null, evt.data.response);

                        if (this.requests[id].payload.method === 'eth_accounts' || this.requests[id].payload.method === 'eth_coinbase') {
                            this.account = evt.data.response.result[0];
                        }

                        if (this.requests[id].payload.method === 'net_version') {
                            this.network = evt.data.response.result;
                        }

                        this.dequeue();
                        break;
                    }

                    case postMessages.PT_SHOW_IFRAME: {
                        this.showIframe();
                        break;
                    }

                    case postMessages.PT_HIDE_IFRAME: {
                        this.hideIframe();
                        break;
                    }

                    case postMessages.PT_USER_DENIED: {
                        const id = evt.data.response ? evt.data.response.id : null;

                        if (id) {
                            this.requests[id].cb(new Error('User denied transaction signature.'));
                        } else {
                            this.queue.forEach(item => item.cb(new Error('User denied transaction signature.')));
                        }

                        this.dequeue();
                        break;
                    }

                    case postMessages.PT_USER_LOGGED_IN: {
                        this.events
                            .filter(event => event.eventName == 'login')
                            .forEach(event => event.callback({
                                provider: 'portis',
                                address: evt.data.response.address,
                            }));
                        break;
                    }
                }
            }
        }, false);
    }
}
