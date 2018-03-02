export default class NanoNetworkApi {

    static get API_URL() { return 'https://cdn.nimiq-network.com/branches/master/nimiq.js' }
    static get satoshis() { return 1e5 }

    static getApi() {
        this._api = this._api || new NanoNetworkApi();
        return this._api;
    }

    constructor() {
        this._apiInitialized = new Promise((resolve) => {
            this._initResolve = resolve;
        });
    }

    async init() {
        await NanoNetworkApi._importApi();
        this.$ = {}
        Nimiq.init(async $ => {
            try {
                await this._onApiReady();
                this._initResolve();
            } catch(e) {
                console.error(e);
                this.onInitializationError(e);
            }
        }, e => {
            this.onDifferentTabError(e);
        });
        return this._apiInitialized;
    }

    async _onApiReady() {
        await Nimiq.Crypto.prepareSyncCryptoWorker();
        this.onInitialized();
    }

    async connect() {
        await this._apiInitialized;
        this.$.consensus = await Nimiq.Consensus.volatileNano();
        this.$.consensus.on('established', e => this._onConsensusEstablished());
        this.$.consensus.network.connect();
        this.$.consensus.blockchain.on('head-changed', e => this._headChanged());
        this.$.consensus.mempool.on('transaction-added', tx => this._transactionAdded(tx));
    }

    async _headChanged() {
        if (!this.$.consensus.established) return;
        // FIXME with subscribed-to addresses
        // const balance = await this._getBalance();
        // if (this._balance === balance) return;
        // this._balance = balance;
        // this.onBalanceChanged(this.balance);
    }

    async _getAccount(address) {
        await this._apiInitialized;
        const account = await this.$.consensus.getAccount(Nimiq.Address.fromUserFriendlyAddress(address));
        return account || { balance: 0 }
    }

    async _getBalance(address) {
        const account = await this._getAccount(address);
        return account.balance / NanoNetworkApi.satoshis;
    }

    _onConsensusEstablished() {
        this._headChanged();
        this.onConsensusEstablished();
    }

    // FIXME with the list of subscribed-to addresses
    // _transactionAdded(tx) {
    //     if (!tx.recipient.equals(this.$.wallet.address)) return;
    //     const sender = tx.senderPubKey.toAddress();
    //     this.onTransactionReceived(sender.toUserFriendlyAddress(), tx.value / NanoNetworkApi.satoshis, tx.fee);
    // }

    /*
        Public API
    */
    async sendTransaction(obj) {
        await this._apiInitialized;
        const senderPublicKey = Nimiq.Address.fromUserFriendlyAddress(Nimiq.PublicKey.unserialize(obj.senderPublicKey));
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Math.round(Number(obj.value) * NanoNetworkApi.satoshis);
        const fee = Math.round(Number(obj.fee) * NanoNetworkApi.satoshis);
        const validityStart = parseInt(obj.validityStart);
        const signature = Nimiq.Signature.unserialize(obj.signature);

        const tx = new Nimiq.BasicTransaction(senderPublicKey, recipientAddr, value, fee, validityStart, signature);

        return this.$.consensus.relayTransaction(tx);
    }

    async getBalance(address) {
        return this._getBalance(address);
    }

    /** @param {string} friendlyAddress */
    async getUnfriendlyAddress(friendlyAddress) {
        await this._apiInitialized;
        return Nimiq.Address.fromUserFriendlyAddress(friendlyAddress);
    }

    onInitialized() {
        console.log('Nimiq API ready to use');
        this.fire('nimiq-api-ready');
    }

    onConsensusEstablished() {
        console.log('consensus established');
        this.fire('nimiq-consensus-established');
    }

    onBalanceChanged(address, balance) {
        console.log('new balance:', {address, balance});
        this.fire('nimiq-balance', {address, balance});
    }

    onTransactionReceived(sender, recipient, value, fee) {
        console.log('received:', value, 'from:', sender, 'txfee:', fee);
        this.fire('nimiq-transaction', { sender, recipient, value, fee });
    }

    onDifferentTabError(e) {
        console.log('Nimiq API is already running in a different tab:', e);
        this.fire('nimiq-different-tab-error', e);
    }

    onInitializationError(e) {
        console.log('Nimiq API could not be initialized:', e);
        this.fire('nimiq-api-fail', e);
    }

    static validateAddress(address) {
        try {
            this.isUserFriendlyAddress(address);
            return true;
        } catch (e) {
            return false;
        }
    }

    // Copied from: https://github.com/nimiq-network/core/blob/master/src/main/generic/consensus/base/account/Address.js

    static isUserFriendlyAddress(str) {
        str = str.replace(/ /g, '');
        if (str.substr(0, 2).toUpperCase() !== 'NQ') {
            throw new Error('Addresses start with NQ', 201);
        }
        if (str.length !== 36) {
            throw new Error('Addresses are 36 chars (ignoring spaces)', 202);
        }
        if (this._ibanCheck(str.substr(4) + str.substr(0, 4)) !== 1) {
            throw new Error('Address Checksum invalid', 203);
        }
    }

    static _ibanCheck(str) {
        const num = str.split('').map((c) => {
            const code = c.toUpperCase().charCodeAt(0);
            return code >= 48 && code <= 57 ? c : (code - 55).toString();
        }).join('');
        let tmp = '';

        for (let i = 0; i < Math.ceil(num.length / 6); i++) {
            tmp = (parseInt(tmp + num.substr(i * 6, 6)) % 97).toString();
        }

        return parseInt(tmp);
    }

    static _importApi() {
        return new Promise((resolve, reject) => {
            let script = document.createElement('script');
            script.type = 'text/javascript';
            script.src = NanoNetworkApi.API_URL;
            script.addEventListener('load', () => resolve(script), false);
            script.addEventListener('error', () => reject(script), false);
            document.body.appendChild(script);
        });
    }

    fire() {
        throw new Error('Method needs to be overwritten by subclasses');
    }
}