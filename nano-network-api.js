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
            setTimeout(resolve, 200);
        });
        this._createConsensusPromise();

        this._balances = new Map();
    }

    async connect() {
        await this._apiInitialized;
        Nimiq.GenesisConfig.bounty();
        this._consensus = await Nimiq.Consensus.volatileNano();
        this._consensus.on('syncing', e => this._onConsensusSyncing());
        this._consensus.on('established', e => this.__onConsensusEstablished());
        this._consensus.on('lost', e => this.__onConsensusLost());

        // this._consensus.on('sync-finished', e => console.log('consensus sync-finished'));
        // this._consensus.on('sync-failed', e => console.log('consensus sync-failed'));
        // this._consensus.on('sync-chain-proof', e => console.log('consensus sync-chain-proof'));
        // this._consensus.on('verify-chain-proof', e => console.log('consensus verify-chain-proof'));

        this._consensus.network.connect();

        this._consensus.blockchain.on('head-changed', block => this._headChanged(block.header));
        this._consensus.mempool.on('transaction-added', tx => this._transactionAdded(tx));
        // this._consensus.mempool.on('transaction-expired', tx => this._transactionExpired(tx));
        this._consensus.mempool.on('transaction-mined', (tx, header) => this._transactionMined(tx, header));
        this._consensus.network.on('peers-changed', () => this._onPeersChanged());
    }

    async _headChanged(header) {
        if (!this._consensus.established) return;
        this._balances.forEach(async (storedBalance, address, map) => {
            const balance = await this._getBalance(address);
            if (storedBalance === balance) return;
            map.set(address, balance);
            this._onBalanceChanged(address, balance);
        });
        this._onHeadChange(header);
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

    __onConsensusEstablished() {
        this._consensusEstablishedResolver();
        this._headChanged(this._consensus.blockchain.head);
        this._onConsensusEstablished();
    }

    __onConsensusLost() {
        this._createConsensusPromise();
        this._onConsensusLost();
    }

    _transactionAdded(tx) {
        const recipientAddr = tx.recipient.toUserFriendlyAddress();
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const trackedAddresses = new Set(this._balances.keys());

        if (trackedAddresses.has(senderAddr) || trackedAddresses.has(recipientAddr)) {
            this._onTransactionPending(senderAddr, recipientAddr, tx.value / NanoNetworkApi.satoshis, tx.fee / NanoNetworkApi.satoshis, tx.hash().toBase64());
        }
    }

    _transactionMined(tx, header) {
        const recipientAddr = tx.recipient.toUserFriendlyAddress();
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const trackedAddresses = new Set(this._balances.keys());

        if (trackedAddresses.has(recipientAddr) || trackedAddresses.has(senderAddr)) {
            this._onTransactionMined(senderAddr, recipientAddr, tx.value / NanoNetworkApi.satoshis, tx.fee / NanoNetworkApi.satoshis, tx.hash().toBase64(), header.height, header.timestamp);
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
            validityStartHeight: <integer>,
            signature: <serialized signature>
        }
    */
    async relayTransaction(obj) {
        await this._consensusEstablished;
        const senderPubKey = Nimiq.PublicKey.unserialize(Nimiq.SerialBuffer.from(obj.senderPubKey));
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(Nimiq.SerialBuffer.from(obj.signature));

        const tx = new Nimiq.BasicTransaction(senderPubKey, recipientAddr, value, fee, validityStartHeight, signature);

        return this._consensus.relayTransaction(tx);
    }

    /**
     * @param {string|Array<string>} addresses
     */
    async subscribe(addresses) {
        if (!(addresses instanceof Array)) addresses = [addresses];

        const balanceChecks = addresses.map(async address => {
            this._subscribeAddress(address);
            this._onBalanceChanged(address, await this._getBalance(address));
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

    getGenesisVestingContracts() {
        const accounts = new Map();
        const buf = Nimiq.BufferUtils.fromBase64(Nimiq.GenesisConfig.GENESIS_ACCOUNTS);
        const count = buf.readUint16();
        for (let i = 0; i < count; i++) {
            const address = Nimiq.Address.unserialize(buf);
            const account = Nimiq.Account.unserialize(buf);

            if (account.type === 1) {
                accounts.set(address.toUserFriendlyAddress(), {
                    balance: account.balance / NanoNetworkApi.satoshis,
                    owner: account.owner.toUserFriendlyAddress(),
                    start: account.vestingStart,
                    stepAmount: account.vestingStepAmount / NanoNetworkApi.satoshis,
                    stepBlocks: account.vestingStepBlocks,
                    totalAmount: account.vestingTotalAmount / NanoNetworkApi.satoshis
                });
            }
        }
        return accounts;
    }

    _onInitialized() {
        // console.log('Nimiq API ready to use');
        this.fire('nimiq-api-ready');
    }

    _onConsensusSyncing() {
        // console.log('consensus syncing');
        this.fire('nimiq-consensus-syncing');
    }

    _onConsensusEstablished() {
        // console.log('consensus established');
        this.fire('nimiq-consensus-established');
    }

    _onConsensusLost() {
        // console.log('consensus lost');
        this.fire('nimiq-consensus-lost');
    }

    _onBalanceChanged(address, balance) {
        // console.log('new balance:', {address, balance});
        this.fire('nimiq-balance', {address, balance});
    }

    _onTransactionPending(sender, recipient, value, fee, hash) {
        // console.log('pending:', { sender, recipient, value, fee, hash });
        this.fire('nimiq-transaction-pending', { sender, recipient, value, fee, hash });
    }

    _onTransactionMined(sender, recipient, value, fee, hash, blockHeight, timestamp) {
        // console.log('mined:', { sender, recipient, value, fee, hash, blockHeight, timestamp });
        this.fire('nimiq-transaction-mined', { sender, recipient, value, fee, hash, blockHeight, timestamp });
    }

    _onDifferentTabError(e) {
        // console.log('Nimiq API is already running in a different tab:', e);
        this.fire('nimiq-different-tab-error', e);
    }

    _onInitializationError(e) {
        // console.log('Nimiq API could not be initialized:', e);
        this.fire('nimiq-api-fail', e);
    }

    _onHeadChange(header) {
        // console.log('height changed:', height);
        this.fire('nimiq-head-change', header.height);
    }

    _onPeersChanged() {
        // console.log('peers changed:', this._consensus.network.peerCount);
        this.fire('nimiq-peer-count', this._consensus.network.peerCount);
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
        throw new Error('The fire() method needs to be overloaded!');
    }
}

// todo replace master by release before release!
