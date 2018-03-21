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
        this._createConsensusPromise();

        this._balances = new Map();
    }

    async connect() {
        await this._apiInitialized;
        Nimiq.GenesisConfig.bounty();
        this._consensus = await Nimiq.Consensus.volatileNano();
        this._consensus.on('syncing', e => this.onConsensusSyncing());
        this._consensus.on('established', e => this._onConsensusEstablished());
        this._consensus.on('lost', e => this._onConsensusLost());

        // this._consensus.on('sync-finished', e => console.log('consensus sync-finished'));
        // this._consensus.on('sync-failed', e => console.log('consensus sync-failed'));
        // this._consensus.on('sync-chain-proof', e => console.log('consensus sync-chain-proof'));
        // this._consensus.on('verify-chain-proof', e => console.log('consensus verify-chain-proof'));

        this._consensus.network.connect();

        this._consensus.blockchain.on('head-changed', e => this._headChanged());
        this._consensus.mempool.on('transaction-added', tx => this._transactionAdded(tx));
        // this._consensus.mempool.on('transaction-expired', tx => this._transactionExpired(tx));
        this._consensus.mempool.on('transaction-mined', (tx, header) => this._transactionMined(tx, header));
        this._consensus.network.on('peers-changed', () => this.onPeersChanged());
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

    async _getAccount(address, stackHeight) {
        await this._consensusEstablished;
        let account;
        try {
            account = await this._consensus.getAccount(Nimiq.Address.fromUserFriendlyAddress(address));
        } catch (e) {
            stackHeight = stackHeight || 0;
            stackHeight++;
            return await new Promise(resolve => {
                const timeout = 1000 * stackHeight;
                setTimeout(async _ => {
                    resolve(await this._getAccount(address, stackHeight));
                }, timeout);
                console.warn(`Could not retrieve account from consensus, retrying in ${timeout / 1000} s`);
            });
        }
        return account || { balance: 0 };
    }

    _subscribeAddress(address) {
        this._balances.set(address, 0);
    }

    async _getBalance(address) {
        const account = await this._getAccount(address);
        const balance = account.balance / NanoNetworkApi.satoshis;
        if (this._balances.has(address)) this._balances.set(address, balance);
        return balance;
    }

    async _requestTransactionHistory(address) {
        await this._consensusEstablished;
        return await this._consensus._requestTransactionHistory(Nimiq.Address.fromUserFriendlyAddress(address));
    }

    _onConsensusEstablished() {
        this._consensusEstablishedResolver();
        this._headChanged();
        this.onConsensusEstablished();
    }

    _onConsensusLost() {
        this._createConsensusPromise();
        this.onConsensusLost();
    }

    _transactionAdded(tx) {
        const recipientAddr = tx.recipient.toUserFriendlyAddress();
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const trackedAddresses = new Set(this._balances.keys());

        if (trackedAddresses.has(senderAddr) || trackedAddresses.has(recipientAddr)) {
            this.onTransactionPending(senderAddr, recipientAddr, tx.value / NanoNetworkApi.satoshis, tx.fee / NanoNetworkApi.satoshis, tx.hash().toBase64());
        }
    }

    _transactionMined(tx, header) {
        const recipientAddr = tx.recipient.toUserFriendlyAddress();
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const trackedAddresses = new Set(this._balances.keys());

        if (trackedAddresses.has(recipientAddr) || trackedAddresses.has(senderAddr)) {
            this.onTransactionMined(senderAddr, recipientAddr, tx.value / NanoNetworkApi.satoshis, tx.fee / NanoNetworkApi.satoshis, tx.hash().toBase64(), header.height, header.timestamp);
        }
    }

    _createConsensusPromise() {
        this._consensusEstablished = new Promise(resolve => {
            this._consensusEstablishedResolver = resolve;
        });
    }

    /*
        Public API

        @param {object} obj: {
            sender: <user friendly address>,
            senderPubKey: <serialized public key>,
            recipient: <user friendly address>,
            value: <value in NIM>,
            fee: <fee in NIM>,
            validityStart: <integer>,
            signature: <serialized signature>
        }
    */
    async relayTransaction(obj) {
        await this._consensusEstablished;
        const senderPubKey = Nimiq.PublicKey.unserialize(Nimiq.SerialBuffer.from(obj.senderPubKey));
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStart = parseInt(obj.validityStart);
        const signature = Nimiq.Signature.unserialize(Nimiq.SerialBuffer.from(obj.signature));

        const tx = new Nimiq.BasicTransaction(senderPubKey, recipientAddr, value, fee, validityStart, signature);

        return this._consensus.relayTransaction(tx);
    }

    /**
     * @param {string|Array<string>} addresses
     */
    async subscribe(addresses) {
        if (!(addresses instanceof Array)) addresses = [addresses];

        const balanceChecks = addresses.map(async address => {
            this._subscribeAddress(address);
            this.onBalanceChanged(address, await this._getBalance(address));
        });

        // Update NanoConsensus subscriptions
        await Promise.all(balanceChecks);
        const addressesAsAddresses = [...this._balances.keys()].map(address => Nimiq.Address.fromUserFriendlyAddress(address));
        await this._consensusEstablished;
        this._consensus.subscribeAccounts(addressesAsAddresses);
    }

    getBalance(address) {
        return this._getBalance(address);
    }

    async requestTransactionHistory(addresses) {
        if (!(addresses instanceof Array)) addresses = [addresses];

        let txs = await Promise.all(addresses.map(address => this._requestTransactionHistory(address)));

        // txs is an array of arrays of objects, which have the format {transaction: Nimiq.Transaction, header: Nimiq.BlockHeader}
        // We need to reduce this to usable simple tx objects

        // First, reduce
        txs = txs.reduce((flat, it) => it ? flat.concat(it) : flat, []);

        // Then map to simple object
        txs = txs.map(tx => ({
            sender: tx.transaction.sender.toUserFriendlyAddress(),
            recipient: tx.transaction.recipient.toUserFriendlyAddress(),
            value: tx.transaction.value / NanoNetworkApi.satoshis,
            fee: tx.transaction.fee / NanoNetworkApi.satoshis,
            hash: tx.transaction.hash().toBase64(),
            blockHeight: tx.header.height,
            timestamp: tx.header.timestamp
        }));

        // Finally, sort the array
        return txs.sort((a, b) => a.blockHeight - b.blockHeight);
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

    onConsensusSyncing() {
        console.log('consensus syncing');
        this.fire('nimiq-consensus-syncing');
    }

    onConsensusEstablished() {
        console.log('consensus established');
        this.fire('nimiq-consensus-established');
    }

    onConsensusLost() {
        console.log('consensus lost');
        this.fire('nimiq-consensus-lost');
    }

    onBalanceChanged(address, balance) {
        console.log('new balance:', {address, balance});
        this.fire('nimiq-balance', {address, balance});
    }

    onTransactionPending(sender, recipient, value, fee, hash) {
        console.log('pending:', { sender, recipient, value, fee, hash });
        this.fire('nimiq-transaction-pending', { sender, recipient, value, fee, hash });
    }

    onTransactionMined(sender, recipient, value, fee, hash, blockHeight, timestamp) {
        console.log('mined:', { sender, recipient, value, fee, hash, blockHeight, timestamp });
        this.fire('nimiq-transaction-mined', { sender, recipient, value, fee, hash, blockHeight, timestamp });
    }

    onDifferentTabError(e) {
        console.log('Nimiq API is already running in a different tab:', e);
        this.fire('nimiq-different-tab-error', e);
    }

    onInitializationError(e) {
        console.log('Nimiq API could not be initialized:', e);
        this.fire('nimiq-api-fail', e);
    }

    onPeersChanged() {
        console.log('peers changed:', this._consensus.network.peerCount);
        this.fire('nimiq-peer-count', this._consensus.network.peerCount);
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
