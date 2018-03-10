export default class NanoNetworkApi {

    static get API_URL() { return 'https://cdn.nimiq-network.com/branches/master/nimiq.js' }
    static get satoshis() { return 1e5 }

    static getApi() {
        this._api = this._api || new NanoNetworkApi();
        return this._api;
    }

    constructor() {
        this._apiInitialized = new Promise(async (resolve) => {
            await NanoNetworkApi._importApi();
            await Nimiq.load();
            resolve();
        });
        this._balances = new Map();
    }

    async connect() {
        await this._apiInitialized;
        this._consensus = await Nimiq.Consensus.volatileNano();
        this._consensus.on('established', e => this._onConsensusEstablished());
        this._consensus.network.connect();
        this._consensus.blockchain.on('head-changed', e => this._headChanged());
        this._consensus.mempool.on('transaction-added', tx => this._transactionAdded(tx));
    }

    async _headChanged() {
        if (!this._consensus.established) return;
        this._balances.forEach(async (storedBalance, address, map) => {
            const balance = await this._getBalance(address);
            if (storedBalance === balance) return;
            map.set(address, balance);
            this.onBalanceChanged(address, balance);
        });
    }

    async _getAccount(address) {
        await this._apiInitialized;
        const account = await this._consensus.getAccount(Nimiq.Address.fromUserFriendlyAddress(address));
        return account || { balance: 0 }
    }

    async _getBalance(address) {
        const account = await this._getAccount(address);
        const balance = account.balance / NanoNetworkApi.satoshis;
        if (this._balances.has(address)) this._balances.set(address, balance);
        return balance;
    }

    _onConsensusEstablished() {
        this._headChanged();
        this.onConsensusEstablished();
    }

    _transactionAdded(tx) {
        const recipientAddr = tx.recipient.toUserFriendlyAddress();
        if (!(new Set(this._balances.keys())).has(recipientAddr)) return;
        const sender = tx.senderPubKey.toAddress();
        this.onTransactionReceived(sender.toUserFriendlyAddress(), recipientAddr, tx.value / NanoNetworkApi.satoshis, tx.fee / NanoNetworkApi.satoshis);
    }

    /*
        Public API
    */
    async relayTransaction(obj) {
        await this._apiInitialized;
        const senderPublicKey = Nimiq.Address.fromUserFriendlyAddress(Nimiq.PublicKey.unserialize(obj.senderPublicKey));
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Math.round(Number(obj.value) * NanoNetworkApi.satoshis);
        const fee = Math.round(Number(obj.fee) * NanoNetworkApi.satoshis);
        const validityStart = parseInt(obj.validityStart);
        const signature = Nimiq.Signature.unserialize(obj.signature);

        const tx = new Nimiq.BasicTransaction(senderPublicKey, recipientAddr, value, fee, validityStart, signature);

        return this._consensus.relayTransaction(tx);
    }

    getBalance(address) {
        return this._getBalance(address);
    }

    subscribeAddress(address) {
        this._balances.set(address, 0);
    }

    subscribeAndGetBalance(address) {
        this.subscribeAddress(address);
        return this.getBalance(address);
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
        console.log('received:', value, 'to:', recipient, 'from:', sender, 'txfee:', fee);
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

// todo replace master by release before release!