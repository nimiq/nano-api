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

        this._isConsensusEstablished = false;
        this._createConsensusPromise();

        this._selfRelayedTransactionHashes = new Set();

        this._balances = new Map();

        /** @type {boolean} */
        this._shouldConnect = true;

        /** @type {Nimiq.BlockHeader|null} */
        this._knownHead = null;
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

        // wait until at least two non-nano agents told us that their subscriptions accept our transaction
        await this._awaitCompatibleAgents(agents => agents.some(agent =>
            agent._remoteSubscription.matchesTransaction(tx)
            && !Nimiq.Services.isNanoNode(agent.peer.peerAddress.services)));

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
        if (!this._shouldConnect || (this._consensus && this._consensus.network._autoConnect)) return;

        try {
            Nimiq.GenesisConfig[this._config.network]();
        } catch (e) {}

        if (!this._consensus) {
            // Uses volatileNano to enable more than one parallel network iframe
            this._consensus = await Nimiq.Consensus.volatileNano();
            this._bindEvents();
        }
        if (this._consensus.network._houseKeepingIntervalId) {
            clearInterval(this._consensus.network._houseKeepingIntervalId)
        }
        this._consensus.network.connect();

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
     * @param {string[]} userFriendlyAddresses
     * @param {boolean} [upgradeToNano]
     * @returns {Promise<Map<string, number>>}
     */
    async connectPico(userFriendlyAddresses = [], upgradeToNano = true) {
        this._shouldConnect = true;
        await this._apiInitialized;
        if (!this._shouldConnect) return new Map();

        const establishedChannels = [];
        const picoHeads = [];
        let currentHead = null;
        /** @type {Nimiq.PeerChannel[]} */
        const picoChannels = [];
        /** @type {Map<string, number>} */
        const picoBalances = new Map();
        const cleanUpHandlers = [];

        if (this._consensus) {
            if (this._consensus.established) {
                // already nano consensus established
                const balances = await this.getBalance(userFriendlyAddresses);
                for (const [address, balance] of balances) { this._balances.set(address, balance); }
                if (upgradeToNano) {
                    // Although we established a nano consensus it might be that it was only reached with our selected
                    // pico peers. Therefore we upgrade to nano again. Note that if we are already on real nano, a
                    // double invocation of connect doesn't do any harm.
                    this.connect();
                }
                return balances;
            } else {
                // hook into the current sync process
                for (const agent of this._consensus._agents.valueIterator()) {
                    if (!Nimiq.Services.isFullNode(agent.peer.peerAddress.services)) continue;
                    // Note that for all agents known to the consensus a channel is currently established.
                    // Agents with closed connections get automatically evicted.
                    establishedChannels.push(agent.peer.channel);
                    if (establishedChannels.length === 4) break;
                }
            }
        } else {
            try {
                Nimiq.GenesisConfig[this._config.network]();
            } catch (e) {}

            // Uses volatileNano to enable more than one parallel network iframe
            this._consensus = await Nimiq.Consensus.volatileNano();
            this._bindEvents();
        }

        const network = this._consensus.network;
        const networkConfig = network.config;

        /** @type {Nimiq.Address[]} */
        const addresses = userFriendlyAddresses.map((address) => Nimiq.Address.fromUserFriendlyAddress(address));

        const balances = await new Promise(async (resolve, reject) => {
            let usingFallback = false;

            const fallbackToNanoConsensus = async () => {
                if (usingFallback) return;
                usingFallback = true;
                console.debug('[Pico] Using Nano fallback.');
                try {
                    await this.connect();
                    const balances = await this.getBalance(userFriendlyAddresses);
                    cleanUpHandlers.forEach(cleanUpHandler => cleanUpHandler());
                    resolve(balances);
                } catch (e) {
                    reject(e);
                }
            };

            const resolveConsensusEstablished = () => {
                console.debug('[Pico] Consensus established');
                cleanUpHandlers.forEach(cleanupHandler => cleanupHandler());
                resolve(picoBalances);
                this.__consensusEstablished();
                this._headChanged(picoHeads[picoHeads.length - 1]);
                if (!upgradeToNano) return;
                // upgrade to normal nano connection to enable housekeeping in Network and to reconnect
                // automatically in case of lost connection. Note that even if we don't upgrade it is still
                // possible to reach nano consensus with the peers we connected to.
                this.connect();
            };

            const onChannelHead = (channel, header) => {
                picoChannels.push(channel);
                picoHeads.push(header);

                if (picoHeads.length >= 3) {
                    let highest = {height: 0}; let lowest = {height: Number.MAX_SAFE_INTEGER};
                    for (const head of picoHeads) {
                        if (head.height > highest.height) highest = head;
                        if (head.height < lowest.height) lowest = head;
                    }
                    if (highest.height - lowest.height <= 1) {
                        if (!currentHead) {
                            this._headChanged(lowest);
                            currentHead = lowest;
                            if (userFriendlyAddresses.length) {
                                // consensus established if balances match
                                getBalances();
                            } else if (picoHeads.every(head => head.equals(currentHead))) {
                                // consensus established if heads exactly match
                                resolveConsensusEstablished();
                            }
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

                // XXX might be enough to request the accounts proof from the channel that just announced its head?
                for(const channel of picoChannels) {
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
                        if (receivedBalanceMsgCount >= 3) resolveConsensusEstablished();
                    }
                }
            };

            function startPicoOnChannel(channel) {
                // Note that we clean up the pico consensus checks once a consensus was reached (either by pico or nano
                // fallback). However, during nano fallback, we keep them alive as we might still get to a pico
                // consensus before the nano consensus.
                const headListenerId = channel.on('head', (msg) => {
                    const header = msg.header;
                    console.debug(`[Pico] Current height is ${header.height}`);
                    onChannelHead(channel, header);
                });
                const accountsProofListenerId = channel.on('accounts-proof', (msg) => onBalancesMsg(msg));

                cleanUpHandlers.push(() => {
                    channel.off('head', headListenerId);
                    channel.off('accounts-proof', accountsProofListenerId);
                });

                channel.getHead();
            }

            for (const channel of establishedChannels) {
                startPicoOnChannel(channel);
            }

            if (establishedChannels.length < 4) {
                const peerJoinedListenerId = network.on('peer-joined', (peer) => {
                    if (Nimiq.Services.isNanoNode(peer.peerAddress.services)) return;
                    startPicoOnChannel(peer.channel);
                });
                cleanUpHandlers.push(() => network.off('peer-joined', peerJoinedListenerId));

                let additionalChannelsToConnectTo = 4 - establishedChannels.length;
                for (const peerAddress of Nimiq.GenesisConfig.SEED_PEERS) {
                    if (additionalChannelsToConnectTo <= 0) break;
                    if (!network.connections.connectOutbound(peerAddress)) continue; // continue on duplicate connection
                    --additionalChannelsToConnectTo;
                }
            }

            const fallbackTimeout = setTimeout(() => {
                if (usingFallback) return;
                fallbackToNanoConsensus();
            }, 5000);
            cleanUpHandlers.push(() => clearTimeout(fallbackTimeout));
        });

        for (const [address, balance] of balances) { this._balances.set(address, balance); }
        return balances;
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

        // Need synced full node to tell us transaction receipts
        await this._awaitCompatibleAgents(agents => agents.some(agent => agent.synced
            && Nimiq.Services.isFullNode(agent.peer.peerAddress.services)));

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
        try {
            this._consensus.mempool.removeTransaction(tx);
        } catch (e) { console.warn(e); }
        return true;
    }

    _bindEvents() {
        this._consensus.on('syncing', e => this._onConsensusSyncing());
        this._consensus.on('established', e => {
            this.__consensusEstablished();
            this._headChanged(this._consensus.blockchain.head.header);
        });
        this._consensus.on('lost', e => this._consensusLost());

        this._consensus.on('transaction-relayed', tx => this._transactionRelayed(tx));

        // this._consensus.on('sync-finished', e => console.log('consensus sync-finished'));
        // this._consensus.on('sync-failed', e => console.log('consensus sync-failed'));
        // this._consensus.on('sync-chain-proof', e => console.log('consensus sync-chain-proof'));
        // this._consensus.on('verify-chain-proof', e => console.log('consensus verify-chain-proof'));

        this._consensus.blockchain.on('head-changed', block => this._headChanged(block.header));
        this._consensus.mempool.on('transaction-added', tx => this._transactionAdded(tx));
        this._consensus.mempool.on('transaction-expired', tx => this._transactionExpired(tx));
        this._consensus.mempool.on('transaction-mined', (tx, header) => this._transactionMined(tx, header));
        this._consensus.network.on('peers-changed', () => this._onPeersChanged());
    }

    async _headChanged(header) {
        if (!this._isConsensusEstablished) return;
        if (this._knownHead && this._knownHead.equals(header)
            || this._knownHead && this._knownHead.height > header.height) {
            // Known or outdated head. Note that this currently doesn't handle rebranches well.
            return;
        }
        const isFirstHead = !this._knownHead;
        this._knownHead = header;
        this._onHeadChange(header);
        if (isFirstHead) return; // no need to recheck balances when we just reached consensus
        this._recheckBalances();
    }

    async _awaitCompatibleAgents(hasCompatibleAgents) {
        return new Promise((resolve) => {
            if (hasCompatibleAgents(this._consensus._agents.values())) {
                resolve();
                return;
            }
            const checkInterval = setInterval(() => {
                if (!hasCompatibleAgents(this._consensus._agents.values())) return;
                resolve();
                clearInterval(checkInterval);
            }, 100);
        });
    }

    /**
     * @returns {Promise<Account[]>} An array element can be NULL if account does not exist
     */
    async _getAccounts(addresses, stackHeight) {
        if (!addresses.length) return [];
        await this._consensusEstablished;

        // This request can only succeed, if we have at least one agent that is synced. Pico consensus is not enough.
        await this._awaitCompatibleAgents(agents => agents.some(agent => agent.synced
            && this._knownHead && agent.knowsBlock(this._knownHead.hash())
            && this._consensus.blockchain.getBlock(this._knownHead.hash()) // stored in our blockchain for validation?
            && !Nimiq.Services.isNanoNode(agent.peer.peerAddress.services)));

        let accounts;
        const addressesAsAddresses = addresses.map(address => Nimiq.Address.fromUserFriendlyAddress(address));
        try {
            accounts = await this._consensus.getAccounts(addressesAsAddresses, this._knownHead.hash());
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
        this._consensus.addSubscriptions(addressesAsAddresses);
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
            let balance = 0;
            if (account) {
                balance = Nimiq.Policy.satoshisToCoins(account.balance) - this._getPendingAmount(address);
            }
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
        address = Nimiq.Address.fromUserFriendlyAddress(address);

        await this._consensusEstablished;
        // need synced full nodes to tell us transaction history
        await this._awaitCompatibleAgents(agents => agents.some(agent => agent.synced
            && Nimiq.Services.isFullNode(agent.peer.peerAddress.services)));

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
        this._isConsensusEstablished = true;
        this._consensusEstablishedResolver();
        this._onConsensusEstablished();
    }

    _consensusLost() {
        this._isConsensusEstablished = false;
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
        if (this._balances.has(senderAddr)) {
            this._recheckBalances(senderAddr);
        }

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
        const senderAddr = Nimiq.Address.fromUserFriendlyAddress(obj.sender);
        const senderType = obj.senderType || Nimiq.Account.Type.BASIC;
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const recipientType = obj.recipientType || Nimiq.Account.Type.BASIC;
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const flags = obj.flags || Nimiq.Transaction.Flag.NONE;
        const data = obj.extraData;

        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey || obj.signerPublicKey));
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));
        const proof = Nimiq.SignatureProof.singleSig(senderPubKey, signature);

        return new Nimiq.ExtendedTransaction(
            senderAddr,
            senderType,
            recipientAddr,
            recipientType,
            value,
            fee,
            validityStartHeight,
            flags,
            data,
            proof.serialize(),
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
