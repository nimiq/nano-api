import Utf8Tools from '/libraries/secure-utils/utf8-tools/utf8-tools.js';

export default (Config) => class NanoNetworkApi {

    static get API_URL() { return Config.cdn }

    static getApi() {
        this._api = this._api || new NanoNetworkApi();
        return this._api;
    }

    constructor() {
        this._apiInitialized = new Promise(async (resolve) => {
            await NanoNetworkApi._importApi();
            try {
                await Nimiq.load();
            } catch (e) {
                _onInitializationError(e.message || e);
                return; // Do not resolve promise
            }
            // setTimeout(resolve, 500);
            this._onInitialized();
            resolve();
        });
        this._createConsensusPromise();

        this._selfRelayedTransactionHashes = new Set();

        this._balances = new Map();
    }

    async connect() {
        await this._apiInitialized;

        Nimiq.GenesisConfig[Config.network]();

        this._consensus = await Nimiq.Consensus.volatileNano();
        this._consensus.on('syncing', e => this._onConsensusSyncing());
        this._consensus.on('established', e => this.__consensusEstablished());
        this._consensus.on('lost', e => this._consensusLost());

        this._consensus.on('transaction-relayed', tx => this._transactionRelayed(tx));

        // this._consensus.on('sync-finished', e => console.log('consensus sync-finished'));
        // this._consensus.on('sync-failed', e => console.log('consensus sync-failed'));
        // this._consensus.on('sync-chain-proof', e => console.log('consensus sync-chain-proof'));
        // this._consensus.on('verify-chain-proof', e => console.log('consensus verify-chain-proof'));

        this._consensus.network.connect();

        this._consensus.blockchain.on('head-changed', block => this._headChanged(block.header));
        this._consensus.mempool.on('transaction-added', tx => this._transactionAdded(tx));
        this._consensus.mempool.on('transaction-expired', tx => this._transactionExpired(tx));
        this._consensus.mempool.on('transaction-mined', (tx, header) => this._transactionMined(tx, header));
        this._consensus.network.on('peers-changed', () => this._onPeersChanged());
    }

    async _headChanged(header) {
        if (!this._consensus.established) return;
        this._recheckBalances();
        this._onHeadChange(header);
    }

    /**
     * @returns {Array<Account>} An array element can be NULL if account does not exist
     */
    async _getAccounts(addresses, stackHeight) {
        if (addresses.length === 0) return [];
        await this._consensusEstablished;
        let accounts;
        const addressesAsAddresses = addresses.map(address => Nimiq.Address.fromUserFriendlyAddress(address));
        try {
            accounts = await this._consensus.getAccounts(addressesAsAddresses);
        } catch (e) {
            stackHeight = stackHeight || 0;
            stackHeight++;
            return await new Promise(resolve => {
                const timeout = 1000 * stackHeight;
                setTimeout(async _ => {
                    resolve(await this._getAccounts(addresses, stackHeight));
                }, timeout);
                console.warn(`Could not retrieve accounts from consensus, retrying in ${timeout / 1000} s`);
            });
        }

        return accounts;
    }

    /**
     * @param {Array<string>} addresses
     */
    async _subscribeAddresses(addresses) {
        const addressesAsAddresses = addresses.map(address => Nimiq.Address.fromUserFriendlyAddress(address));
        await this._consensusEstablished;
        this._consensus.subscribeAccounts(addressesAsAddresses);
    }

    /**
     * @param {Array<string>} addresses
     * @returns {Map}
     */
    async _getBalances(addresses) {
        let accounts = await this._getAccounts(addresses);

        const balances = new Map();

        accounts.forEach((account, i) => {
            const address = addresses[i];
            const balance = account ? Nimiq.Policy.satoshisToCoins(account.balance) : 0;
            balances.set(address, balance);
        });

        return balances;
    }

    /**
     * @param {string} address
     * @param {Map} [knownReceipts] A map with the tx hash as key and the blockhash as value
     * @param {uint} [fromHeight]
     */
    async _requestTransactionHistory(address, knownReceipts = new Map(), fromHeight = 0) {
        await this._consensusEstablished;
        address = Nimiq.Address.fromUserFriendlyAddress(address);

        // Inpired by Nimiq.BaseConsensus._requestTransactionHistory()

        // 1. Get transaction receipts.
        let receipts;
        let retryCounter = 1;
        while (!(receipts instanceof Array)) {
            // Return after the 3rd try
            if (retryCounter >= 4) return {
                transactions: [],
                removedTxHashes: []
            };

            try {
                receipts = await this._consensus._requestTransactionReceipts(address);
                //console.log(`Received ${receipts.length} receipts from the network.`);
            } catch(e) {
                await new Promise(res => setTimeout(res, 1000)); // wait 1 sec until retry
            }

            retryCounter++;
        }

        // 2a. Filter out removed transactions
        const knownTxHashes = [...knownReceipts.keys()];

        // The JungleDB does currently not support TransactionReceiptsMessage's offset parameter.
        // Thus, when the limit is returned, we can make no assumption about removed transactions.
        // TODO: FIXME when offset is enabled
        let removedTxHashes = [];
        if (receipts.length === Nimiq.TransactionReceiptsMessage.RECEIPTS_MAX_COUNT) {
            console.warn('Maximum number of receipts returned, cannot determine removed transactions. Transaction history is likely incomplete.');
        } else {
            const receiptTxHashes = receipts.map(r => r.transactionHash.toBase64());
            removedTxHashes = knownTxHashes.filter(knownTxHash => !receiptTxHashes.includes(knownTxHash));
        }

        // 2b. Filter out known receipts.
        receipts = receipts.filter(receipt => {
            if (receipt.blockHeight < fromHeight) return false;

            const hash = receipt.transactionHash.toBase64();

            // Known transaction
            if (knownTxHashes.includes(hash)) {
                // Check if block has changed
                return receipt.blockHash.toBase64() !== knownReceipts.get(hash);
            }

            // Unknown transaction
            return true;
        })
        // Sort in reverse, to resolve recent transactions first
        .sort((a, b) => b.blockHeight - a.blockHeight);

        // console.log(`Reduced to ${receipts.length} unknown receipts.`);

        const unresolvedReceipts = [];

        // 3. Request proofs for missing blocks.
        /** @type {Array.<Promise.<Block>>} */
        const blockRequests = [];
        let lastBlockHash = null;
        for (const receipt of receipts) {
            if (!receipt.blockHash.equals(lastBlockHash)) {
                // eslint-disable-next-line no-await-in-loop
                const block = await this._consensus._blockchain.getBlock(receipt.blockHash);
                if (block) {
                    blockRequests.push(Promise.resolve(block));
                } else {
                    const request = this._consensus._requestBlockProof(receipt.blockHash, receipt.blockHeight)
                        .catch(e => {
                            unresolvedReceipts.push(receipt);
                            console.error(NanoNetworkApi, `Failed to retrieve proof for block ${receipt.blockHash}`
                                + ` (${e}) - transaction history may be incomplete`)
                        });
                    blockRequests.push(request);
                }

                lastBlockHash = receipt.blockHash;
            }
        }
        const blocks = await Promise.all(blockRequests);

        // console.log(`Transactions are in ${blocks.length} blocks`);
        // if (unresolvedReceipts.length) console.log(`Could not get block for ${unresolvedReceipts.length} receipts`);

        // 4. Request transaction proofs.
        const transactionRequests = [];
        for (const block of blocks) {
            if (!block) continue;

            const request = this._consensus._requestTransactionsProof([address], block)
                .then(txs => txs.map(tx => ({ transaction: tx, header: block.header })))
                .catch(e => console.error(NanoNetworkApi, `Failed to retrieve transactions for block ${block.hash()}`
                    + ` (${e}) - transaction history may be incomplete`));
            transactionRequests.push(request);
        }

        const transactions = await Promise.all(transactionRequests);

        // Reverse array, so that oldest transactions are first
        transactions.reverse();
        unresolvedReceipts.reverse();

        return {
            transactions: transactions
                .reduce((flat, it) => it ? flat.concat(it) : flat, [])
                .sort((a, b) => a.header.height - b.header.height),
            removedTxHashes,
            unresolvedReceipts
        };
    }

    __consensusEstablished() {
        this._consensusEstablishedResolver();
        this._headChanged(this._consensus.blockchain.head);
        this._onConsensusEstablished();
    }

    _consensusLost() {
        this._createConsensusPromise();
        this._onConsensusLost();
    }

    _transactionAdded(tx) {
        // Self-relayed transactions are added by the 'transaction-requested' event
        const hash = tx.hash().toBase64();
        if (this._selfRelayedTransactionHashes.has(hash)) return;

        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this._recheckBalances(senderAddr);

        this._onTransactionPending(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), Utf8Tools.utf8ByteArrayToString(tx.data), hash, tx.validityStartHeight);
    }

    _transactionExpired(tx) {
        const senderAddr = tx.sender.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this._recheckBalances(senderAddr);

        this._onTransactionExpired(tx.hash().toBase64());
    }

    _transactionMined(tx, header) {
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this._recheckBalances(senderAddr);

        this._onTransactionMined(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), Utf8Tools.utf8ByteArrayToString(tx.data), tx.hash().toBase64(), header.height, header.timestamp, tx.validityStartHeight);
    }

    _transactionRelayed(tx) {
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this._recheckBalances(senderAddr);

        this._onTransactionRelayed(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), Utf8Tools.utf8ByteArrayToString(tx.data), tx.hash().toBase64(), tx.validityStartHeight);
    }

    _createConsensusPromise() {
        this._consensusEstablished = new Promise(resolve => {
            this._consensusEstablishedResolver = resolve;
        });
    }

    _globalHashrate(difficulty) {
        return Math.round(difficulty * Math.pow(2, 16) / Nimiq.Policy.BLOCK_TIME);
    }

    async _recheckBalances(addresses) {
        if (!addresses) addresses = [...this._balances.keys()];
        if (!(addresses instanceof Array)) addresses = [addresses];

        const balances = await this._getBalances(addresses);

        for (let [address, balance] of balances) {
            balance -= this._getPendingAmount(address);

            if (this._balances.get(address) === balance) {
                balances.delete(address);
                continue;
            }

            balances.set(address, balance);
            this._balances.set(address, balance);
        }

        if (balances.size) this._onBalancesChanged(balances);
    }

    _getPendingAmount(address) {
        const txs = this._consensus.mempool.getPendingTransactions(Nimiq.Address.fromUserFriendlyAddress(address));
        const pendingAmount = txs.reduce((acc, tx) => acc + Nimiq.Policy.satoshisToCoins(tx.value + tx.fee), 0);
        return pendingAmount;
    }

    /*
        Public API

        @param {Object} obj: {
            sender: <user friendly address>,
            senderPubKey: <serialized public key>,
            recipient: <user friendly address>,
            value: <value in NIM>,
            fee: <fee in NIM>,
            validityStartHeight: <integer>,
            signature: <serialized signature>
        }
    */
    async relayTransaction(txObj) {
        await this._consensusEstablished;
        let tx;
        if (txObj.isVesting) {
            tx = await this._createVestingTransactionFromObject(txObj);
        } else if (txObj.extraData && txObj.extraData.length > 0) {
            tx = await this._createExtendedTransactionFromObject(txObj);
        } else {
            tx = await this._createBasicTransactionFromObject(txObj);
        }
        // console.log("Debug: transaction size was:", tx.serializedSize);
        this._selfRelayedTransactionHashes.add(tx.hash().toBase64());
        return this._consensus.relayTransaction(tx);
    }

    async getTransactionSize(txObj) {
        await this._apiInitialized;
        let tx;
        if (txObj.extraData && txObj.extraData.length > 0) {
            tx = await this._createExtendedTransactionFromObject(txObj);
        } else {
            tx = await this._createBasicTransactionFromObject(txObj);
        }
        return tx.serializedSize;
    }

    async _createBasicTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey));
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));

        return new Nimiq.BasicTransaction(senderPubKey, recipientAddr, value, fee, validityStartHeight, signature);
    }

    async _createExtendedTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey));
        const senderAddr = senderPubKey.toAddress();
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));
        const data = Utf8Tools.stringToUtf8ByteArray(obj.extraData);

        const proof = Nimiq.SignatureProof.singleSig(senderPubKey, signature);
        const serializedProof = proof.serialize();

        return new Nimiq.ExtendedTransaction(
            senderAddr,    Nimiq.Account.Type.BASIC,
            recipientAddr, Nimiq.Account.Type.BASIC,
            value,
            fee,
            validityStartHeight,
            Nimiq.Transaction.Flag.NONE,
            data,
            serializedProof
        );
    }

    async _createVestingTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey));
        const recipientAddr = senderPubKey.toAddress();
        const senderAddr = Nimiq.Address.fromUserFriendlyAddress(obj.sender);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));
        const data = Utf8Tools.stringToUtf8ByteArray(obj.extraData);

        const proof = Nimiq.SignatureProof.singleSig(senderPubKey, signature);
        const serializedProof = proof.serialize();

        return new Nimiq.ExtendedTransaction(
            senderAddr,    Nimiq.Account.Type.VESTING,
            recipientAddr, Nimiq.Account.Type.BASIC,
            value,
            fee,
            validityStartHeight,
            Nimiq.Transaction.Flag.NONE,
            data,
            serializedProof
        );
    }

    /**
     * @param {string|Array<string>} addresses
     */
    async subscribe(addresses) {
        if (!(addresses instanceof Array)) addresses = [addresses];
        this._subscribeAddresses(addresses);
        this._recheckBalances(addresses);
    }

    /**
     * @param {string|Array<string>} addresses
     * @returns {Map}
     */
    getBalance(addresses) {
        if (!(addresses instanceof Array)) addresses = [addresses];

        const balances = this._getBalances(addresses);
        for (const [address, balance] of balances) { this._balances.set(address, balance); }

        return balances;
    }

    async getAccountTypeString(address) {
        const account = (await this._getAccounts([address]))[0];

        if (!account) return 'basic';

        // See Nimiq.Account.Type
        switch (account.type) {
            case Nimiq.Account.Type.BASIC: return 'basic';
            case Nimiq.Account.Type.VESTING: return 'vesting';
            case Nimiq.Account.Type.HTLC: return 'htlc';
            default: return false;
        }
    }

    async requestTransactionHistory(addresses, knownReceipts, fromHeight) {
        if (!(addresses instanceof Array)) addresses = [addresses];

        let results = await Promise.all(addresses.map(address => this._requestTransactionHistory(address, knownReceipts.get(address), fromHeight)));

        // txs is an array of objects of arrays, which have the format {transaction: Nimiq.Transaction, header: Nimiq.BlockHeader}
        // We need to reduce this to usable simple tx objects

        // Construct arrays with their relavant information
        let txs = results.map(r => r.transactions);
        let removedTxs = results.map(r => r.removedTxHashes);
        let unresolvedTxs = results.map(r => r.unresolvedReceipts);

        // First, reduce
        txs = txs.reduce((flat, it) => it ? flat.concat(it) : flat, []);
        removedTxs = removedTxs.reduce((flat, it) => it ? flat.concat(it) : flat, []);
        unresolvedTxs = unresolvedTxs.reduce((flat, it) => it ? flat.concat(it) : flat, []);

        // Then map to simple objects
        txs = txs.map(tx => ({
            sender: tx.transaction.sender.toUserFriendlyAddress(),
            recipient: tx.transaction.recipient.toUserFriendlyAddress(),
            value: Nimiq.Policy.satoshisToCoins(tx.transaction.value),
            fee: Nimiq.Policy.satoshisToCoins(tx.transaction.fee),
            extraData: Utf8Tools.utf8ByteArrayToString(tx.transaction.data),
            hash: tx.transaction.hash().toBase64(),
            blockHeight: tx.header.height,
            blockHash: tx.header.hash().toBase64(),
            timestamp: tx.header.timestamp,
            validityStartHeight: tx.validityStartHeight
        }));

        // Remove duplicate txs
        const _txHashes = txs.map(tx => tx.hash);
        txs = txs.filter((tx, index) => {
            return _txHashes.indexOf(tx.hash) === index;
        });

        return {
            newTransactions: txs,
            removedTransactions: removedTxs,
            unresolvedTransactions: unresolvedTxs
        };
    }

    async getGenesisVestingContracts() {
        await this._apiInitialized;
        const accounts = [];
        const buf = Nimiq.BufferUtils.fromBase64(Nimiq.GenesisConfig.GENESIS_ACCOUNTS);
        const count = buf.readUint16();
        for (let i = 0; i < count; i++) {
            const address = Nimiq.Address.unserialize(buf);
            const account = Nimiq.Account.unserialize(buf);

            if (account.type === 1) {
                accounts.push({
                    address: address.toUserFriendlyAddress(),
                    // balance: Nimiq.Policy.satoshisToCoins(account.balance),
                    owner: account.owner.toUserFriendlyAddress(),
                    start: account.vestingStart,
                    stepAmount: Nimiq.Policy.satoshisToCoins(account.vestingStepAmount),
                    stepBlocks: account.vestingStepBlocks,
                    totalAmount: Nimiq.Policy.satoshisToCoins(account.vestingTotalAmount)
                });
            }
        }
        return accounts;
    }

    async removeTxFromMempool(txObj) {
        const tx = await this._createBasicTransactionFromObject(txObj);
        this._consensus.mempool.removeTransaction(tx);
    }

    _onInitialized() {
        // console.log('Nimiq API ready to use');
        this.fire('nimiq-api-ready');
    }

    _onConsensusSyncing() {
        console.log('consensus syncing');
        this.fire('nimiq-consensus-syncing');
    }

    _onConsensusEstablished() {
        console.log('consensus established');
        this.fire('nimiq-consensus-established');
    }

    _onConsensusLost() {
        console.log('consensus lost');
        this.fire('nimiq-consensus-lost');
    }

    _onBalancesChanged(balances) {
        // console.log('new balances:', balances);
        this.fire('nimiq-balances', balances);
    }

    _onTransactionPending(sender, recipient, value, fee, extraData, hash, validityStartHeight) {
        // console.log('pending:', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
        this.fire('nimiq-transaction-pending', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
    }

    _onTransactionExpired(hash) {
        // console.log('expired:', hash);
        this.fire('nimiq-transaction-expired', hash);
    }

    _onTransactionMined(sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, validityStartHeight) {
        // console.log('mined:', { sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, validityStartHeight });
        this.fire('nimiq-transaction-mined', { sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, validityStartHeight });
    }

    _onTransactionRelayed(sender, recipient, value, fee, extraData, hash, validityStartHeight) {
        console.log('relayed:', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
        this.fire('nimiq-transaction-relayed', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
    }

    _onDifferentTabError(e) {
        // console.log('Nimiq API is already running in a different tab:', e);
        this.fire('nimiq-different-tab-error', e);
    }

    _onInitializationError(e) {
        console.error('Nimiq API could not be initialized:', e);
        this.fire('nimiq-api-fail', e);
    }

    _onHeadChange(header) {
        // console.log('height changed:', height);
        this.fire('nimiq-head-change', {
            height: header.height,
            globalHashrate: this._globalHashrate(header.difficulty)
        });
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
