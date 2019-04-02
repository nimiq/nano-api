import {Utf8Tools} from '@nimiq/utils';

export class NanoNetworkApi {

    /**
     * @param {{cdn:string, network:string}} config
     */
    constructor(config) {
        this._config = config;
        this._apiInitialized = new Promise(async (resolve) => {
            await this._importApi();
            try {
                await Nimiq.load();
            } catch (e) {
                this._onInitializationError(e.message || e);
                return; // Do not resolve promise
            }
            // setTimeout(resolve, 500);
            this._onInitialized();
            resolve();
        });
        this._createConsensusPromise();

        this._selfRelayedTransactionHashes = new Set();

        this._balances = new Map();

        /** @type {Nimiq.PeerChannel[]} */
        this._picoChannels = [];

        /** @type {boolean} */
        this._shouldConnect = true;
    }

    get apiUrl() { return this._config.cdn }

    fire(event, data) {
        throw new Error('The fire() method needs to be overloaded!');
    }

    /**
     *  @param {Object} txObj: {
     *         sender: <user friendly address>,
     *         senderType: <Nimiq.Account.Type?>,
     *         senderPubKey: <serialized public key>,
     *         recipient: <user friendly address>,
     *         recipientType: <Nimiq.Account.Type?>,
     *         value: <value in NIM>,
     *         fee: <fee in NIM>,
     *         validityStartHeight: <integer>,
     *         signature: <serialized signature> ,
     *         extraData: <data as string or byte array>
     *  }
     * @returns {Promise<void>}
     */
    async relayTransaction(txObj) {
        await this._consensusEstablished;
        const tx = await this._createTransactionFromObject(txObj);
        // console.log("Debug: transaction size was:", tx.serializedSize);
        this._selfRelayedTransactionHashes.add(tx.hash().toBase64());
        this._consensus.relayTransaction(tx);
        return true;
    }

    /**
     * @param {Object} txObj
     * @returns {Promise<number>}
     */
    async getTransactionSize(txObj) {
        await this._apiInitialized;
        const tx = await this._createTransactionFromObject(txObj);
        return tx.serializedSize;
    }

    async connect() {
        this._shouldConnect = true;
        await this._apiInitialized;
        if (!this._shouldConnect) return;

        try {
            Nimiq.GenesisConfig[this._config.network]();
        } catch (e) {}

        // Uses volatileNano to enable more than one parallel network iframe
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

        return true;
    }

    async disconnect() {
        this._shouldConnect = false;
        await this._apiInitialized;
        if (this._shouldConnect) return;
        this._consensus && this._consensus.network && this._consensus.network.disconnect();
        return true;
    }

    /**
     * @param {string[]}
     * @returns {Promise<Map<string, number>>}
     */
    async connectPico(userFriendlyAddresses = []) {
        return new Promise(async (resolve) => {
            await this._apiInitialized;

            /** @type {Nimiq.Address[]} */
            const addresses = userFriendlyAddresses.map((address) => Nimiq.Address.fromUserFriendlyAddress(address));

            try {
                Nimiq.GenesisConfig[this._config.network]();
            } catch (e) {}

            // Uses volatileNano to enable more than one parallel network iframe
            const consensus = await Nimiq.Consensus.volatileNano();
            const networkConfig = consensus.network.config;

            const picoHeads = [];
            let currentHead = null;
            /** @type {Map<string, number>} */
            const picoBalances = new Map();
            let resolved = false;

            const fallbackToNanoConsensus = async () => {
                this.connect()
                const balances = await this.getBalance(userFriendlyAddresses);
                resolve(balances);
                resolved = true;
            }

            const onChannelHead = (channel, header) => {
                this._picoChannels.push(channel);
                picoHeads.push(header);

                if (this._picoChannels.length >= 3) {
                    let highest = {height: 0}; let lowest = {height: Number.MAX_SAFE_INTEGER};
                    for (const head of picoHeads) {
                        if (head.height > highest.height) highest = head;
                        if (head.height < lowest.height) lowest = head;
                    }
                    if (highest.height - lowest.height <= 1) {
                        if (!currentHead) {
                            this._onHeadChange(lowest);
                            currentHead = lowest;
                            getBalances();
                        }
                    }
                    else {
                        console.warn('[Pico] Peers disagree about head height:', lowest.height, highest.height);
                        fallbackToNanoConsensus();
                    }
                }
            };

            const getBalances = () => {
                if (addresses.length === 0) return;
                console.debug('[Pico] Getting balances');

                for(const channel of this._picoChannels) {
                    channel.getAccountsProof(currentHead.hash(), addresses);
                }
            };

            let hasBalanceConsensus = true;
            let receivedBalanceMsgCount = 0;
            const onBalancesMsg = (msg) => {
                console.debug('[Pico] Received accounts-proof message', msg);
                if (hasBalanceConsensus && msg.hasProof && msg.blockHash.equals(currentHead.hash())) {
                    console.debug('[Pico] Verifying message');
                    msg.proof.verify(); // Index accounts
                    if (msg.proof.root().equals(currentHead.accountsHash)) {
                        console.debug('[Pico] Getting accounts from message');
                        for (let i = 0; i < addresses.length; i++) {
                            const address = addresses[i];
                            const userFriendlyAddress = address.toUserFriendlyAddress();
                            console.debug('[Pico] Getting account', userFriendlyAddress);
                            const account = msg.proof.getAccount(address);
                            const balance = account ? Nimiq.Policy.satoshisToCoins(account.balance) : 0;
                            console.debug('[Pico] Balance of account', balance);

                            const storedBalance = picoBalances.get(userFriendlyAddress);
                            if (!storedBalance) picoBalances.set(userFriendlyAddress, balance);
                            else if (storedBalance !== balance) {
                                hasBalanceConsensus = false;
                                console.warn('[Pico] Peers disagree about balances');
                                fallbackToNanoConsensus();
                                return;
                            }
                        }
                        receivedBalanceMsgCount += 1;
                        console.debug('[Pico] Received balance msg count:', receivedBalanceMsgCount);
                        if (receivedBalanceMsgCount >= 3) {
                            resolve(picoBalances);
                            resolved = true;
                        }
                    }
                }
            };

            // TODO: Store randomly chosen seeds here to not connect twice to the same
            const connectedSeeds = [];

            for (let i = 0; i < 4; i++) {
                const connector = new Nimiq.WebSocketConnector(Nimiq.Protocol.WSS, 'wss', networkConfig);

                connector.on('connection', (conn) => {
                    const channel = new Nimiq.PeerChannel(conn);
                    const agent = new Nimiq.NetworkAgent(consensus.blockchain, consensus.network.addresses, networkConfig, channel);
                    let header = null;
                    channel.on('head', (msg) => {
                        header = msg.header;
                        console.debug(`[Pico] Current height is ${header.height}`);
                        onChannelHead(channel, header);
                    });
                    channel.on('accounts-proof', (msg) => {
                        onBalancesMsg(msg);
                    })
                    agent.on('handshake', () => {
                        channel.getHead();
                    });
                });

                // Testnet only has 4 seeds
                connector.connect(Nimiq.GenesisConfig.SEED_PEERS[i]);
            }

            setTimeout(() => {
                if (resolved) return;
                fallbackToNanoConsensus();
            }, 5000);
        });
    }

     /**
     * @param {string|Array<string>} addresses
     */
    async subscribe(addresses) {
        if (!(addresses instanceof Array)) addresses = [addresses];
        this._subscribeAddresses(addresses);
        this._recheckBalances(addresses);
        return true;
    }

    /**
     * @param {string|Array<string>} addresses
     * @returns {Promise<Map<string, number>>}
     */
    async getBalance(addresses) {
        if (!(addresses instanceof Array)) addresses = [addresses];

        const balances = await this._getBalances(addresses);
        for (const [address, balance] of balances) { this._balances.set(address, balance); }

        return balances;
    }

    /**
     * @param {string} address
     * @returns {string | boolean}
     */
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
            extraData: tx.transaction.data,
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

    async requestTransactionReceipts(address) {
        const addressBuffer = Nimiq.Address.fromUserFriendlyAddress(address);
        // @ts-ignore _requestTransactionReceipts is private currently
        return this._consensus._requestTransactionReceipts(addressBuffer);
    }

    async getGenesisVestingContracts() {
        await this._apiInitialized;
        const contracts = [];
        const buf = Nimiq.BufferUtils.fromBase64(Nimiq.GenesisConfig.GENESIS_ACCOUNTS);
        const count = buf.readUint16();
        for (let i = 0; i < count; i++) {
            const address = Nimiq.Address.unserialize(buf);
            const account = Nimiq.Account.unserialize(buf);

            if (account.type === Nimiq.Account.Type.VESTING) {
                contracts.push({
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
        return contracts;
    }

    async removeTxFromMempool(txObj) {
        const tx = await this._createTransactionFromObject(txObj);
        this._consensus.mempool.removeTransaction(tx);
        return true;
    }

    async _headChanged(header) {
        if (!this._consensus.established) return;
        this._recheckBalances();
        this._onHeadChange(header);
    }

    /**
     * @returns {Promise<Account[]>} An array element can be NULL if account does not exist
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
     * @param {string[]} addresses
     */
    async _subscribeAddresses(addresses) {
        const addressesAsAddresses = addresses.map(address => Nimiq.Address.fromUserFriendlyAddress(address));
        await this._consensusEstablished;
        this._consensus.subscribeAccounts(addressesAsAddresses);
    }

    /**
     * @param {string[]} addresses
     * @returns {Promise<Map<string, number>>}
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
     * @param {Map} [knownReceipts] A map with the tx hash as key and the blockhash as value (both base64)
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
        // Self-relayed transactions are added by the 'transaction-relayed' event
        const hash = tx.hash().toBase64();
        if (this._selfRelayedTransactionHashes.has(hash)) return;

        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this._recheckBalances(senderAddr);

        this._onTransactionPending(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), tx.data, hash, tx.validityStartHeight);
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

        this._onTransactionMined(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), tx.data, tx.hash().toBase64(), header.height, header.timestamp, tx.validityStartHeight);
    }

    _transactionRelayed(tx) {
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this._recheckBalances(senderAddr);

        this._onTransactionRelayed(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), tx.data, tx.hash().toBase64(), tx.validityStartHeight);
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

    async _createTransactionFromObject(txObj) {
        if (typeof txObj.extraData === 'string') {
            txObj.extraData = Utf8Tools.stringToUtf8ByteArray(txObj.extraData);
        }

        if (
            (txObj.extraData && txObj.extraData.length > 0)
            || txObj.senderType
            || txObj.recipientType
        ) {
            return this._createExtendedTransactionFromObject(txObj);
        } else {
            return this._createBasicTransactionFromObject(txObj);
        }
    }

    async _createBasicTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey || obj.signerPublicKey));
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));

        return new Nimiq.BasicTransaction(senderPubKey, recipientAddr, value, fee, validityStartHeight, signature);
    }

    async _createExtendedTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey || obj.signerPublicKey));
        const senderAddr = Nimiq.Address.fromUserFriendlyAddress(obj.sender);
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));
        const data = obj.extraData;

        const proof = Nimiq.SignatureProof.singleSig(senderPubKey, signature);
        const serializedProof = proof.serialize();

        return new Nimiq.ExtendedTransaction(
            senderAddr,    obj.senderType || Nimiq.Account.Type.BASIC,
            recipientAddr, obj.recipientType || Nimiq.Account.Type.BASIC,
            value,
            fee,
            validityStartHeight,
            Nimiq.Transaction.Flag.NONE,
            data,
            serializedProof
        );
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

    _onInitializationError(e) {
        console.error('Nimiq API could not be initialized:', e);
        this.fire('nimiq-api-fail', e);
    }

    _onHeadChange(header) {
        // console.log('height changed:', header.height);
        this.fire('nimiq-head-change', {
            height: header.height,
            globalHashrate: this._globalHashrate(header.difficulty)
        });
    }

    _onPeersChanged() {
        // console.log('peers changed:', this._consensus.network.peerCount);
        this.fire('nimiq-peer-count', this._consensus.network.peerCount);
    }

    _importApi() {
        return new Promise((resolve, reject) => {
            let script = document.createElement('script');
            script.type = 'text/javascript';
            script.src = this.apiUrl;
            script.addEventListener('load', () => resolve(script), false);
            script.addEventListener('error', () => reject(script), false);
            document.body.appendChild(script);
        });
    }
}
