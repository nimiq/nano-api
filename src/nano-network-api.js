import {Utf8Tools} from '@nimiq/utils';

export class NanoNetworkApi {

    /**
     * @param {{cdn: string, network: string}} config
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
     * @returns {Promise<Nimiq.Client.TransactionDetails>}
     */
    async relayTransaction(txObj) {
        let isTxSent = false;
        let mustWaitBeforeRelay = !this._isConsensusEstablished;

        await this._consensusEstablished;

        const tx = await this._createTransactionFromObject(txObj);
        // console.log("Debug: transaction size was:", tx.serializedSize);
        this._selfRelayedTransactionHashes.add(tx.hash().toBase64());

        let txDetails;
        let attempts = 0;
        while (!isTxSent) {
            // Wait 1s before sending the transaction so that peers can announce their mempool service to us
            if (mustWaitBeforeRelay) await new Promise(res => setTimeout(res, 1000));

            txDetails = await this._client.sendTransaction(tx);

            if (txDetails.state === Nimiq.Client.TransactionState.INVALIDATED) {
                throw new Error('Transaction is invalid');
            }

            isTxSent = txDetails.state === Nimiq.Client.TransactionState.PENDING ||
                       txDetails.start === Nimiq.Client.TransactionState.MINED;

            mustWaitBeforeRelay = true;
            if (++attempts === 3) break;
        }

        return txDetails.toPlain();
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
        await this._apiInitialized;

        try {
            Nimiq.GenesisConfig[this._config.network]();
        } catch (e) {
            console.warn('Already connected');
            return;
        }

        this._client = Nimiq.Client.Configuration.builder().volatile().instantiateClient();

        this._bindEvents();

        return this._client;
    }

     /**
     * @param {string|Array<string>} addresses
     */
    async subscribe(addresses) {
        if (!(addresses instanceof Array)) addresses = [addresses];
        await this._apiInitialized;
        this._client.addTransactionListener(this._onTransaction.bind(this), addresses);
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

    // To support un-updated client code
    async connectPico(addresses) {
        console.warn('connectPico() is deprecated. Use getBalance() instead.');
        return this.getBalance(addresses);
    }

    /**
     * @param {string} address
     * @returns {string | boolean}
     */
    async getAccountTypeString(address) {
        const account = (await this._getAccounts([address]))[0];
        return Nimiq.Account.Type.toString(account.type);
    }

    /**
     * @param {string[]} addresses
     * @param {Map<string, string>} [knownReceipts] A map with the tx hash as key and the blockhash as value (both base64)
     * @param {uint} [fromHeight]
     */
    async requestTransactionHistory(addresses, knownReceipts = new Map(), fromHeight = 0) {
        if (!(addresses instanceof Array)) addresses = [addresses];
        await this._consensusEstablished;

        const newReceiptsMap = new Map();
        const knownReceiptHashes = new Set([...knownReceipts.entries()].map(entry => entry[0] + entry[1]));

        let wasRateLimited = false;

        // 1. Get all receipts for all addresses, flattened, only unknowns, unique
        (await Promise.all(addresses.map(address => this._client
            .getTransactionReceiptsByAddress(address)
            .catch(() => {
                wasRateLimited = true;
                return [];
            })
        )))
            .forEach(receiptsOfAddress => {
                for (const receipt of receiptsOfAddress) {
                    // Skip old receipts
                    if (receipt.blockHeight < fromHeight) continue;

                    const combinedHash = receipt.transactionHash.toBase64() + receipt.blockHash.toBase64();

                    // Skip known receipts
                    if (knownReceiptHashes.has(combinedHash)) continue;

                    // Skip dublicate receipts
                    if (newReceiptsMap.has(combinedHash)) continue;

                    newReceiptsMap.set(combinedHash, receipt);
                }
            });

        // 2. Sort in reverse, to resolve recent transactions first
        const newReceipts = [...newReceiptsMap.values()].sort((a, b) => b.blockHeight - a.blockHeight);

        // 3. Determine unique blocks that must be fetched (that contain unknown txs)
        /** @type {Map<string, Nimiq.TransactionReceipt} */
        const newBlocks = new Map();
        for (const receipt of newReceipts) {
            const entry = newBlocks.get(receipt.blockHash);
            if (entry) {
                // The entry is updated in the map by reference.
                entry.push(receipt);
            } else {
                newBlocks.set(receipt.blockHash, [receipt]);
            }
        }

        // 4. Fetch all required blocks (and allow fetching to fail)
        /** @type {Map<string, Promise<Nimiq.Block | null>>} */
        const blocks = new Map([...newBlocks.keys()].map(blockHash => [blockHash, this._client
            .getBlock(blockHash, true)
            .catch(() => {
                wasRateLimited = true;
                return null;
            }),
        ]));

        let txs =
            // 5. Fetch required transactions from the blocks
            (await Promise.all([...newBlocks.entries()].map(async ([blockHash, receipts]) => {
                const block = await blocks.get(blockHash);
                if (!block) return [];

                const txHashes = receipts.map(receipt => receipt.transactionHash);

                const consensus = await this._client._consensus;
                const txs = await consensus
                    .getTransactionsFromBlock(txHashes, blockHash, block.height, block)
                    .catch(() => {
                        wasRateLimited = true;
                        return [];
                    });
                return txs.map(tx => ({ transaction: tx, header: block.header }));
            })))
            // 6. Reverse array, so that oldest transactions are first
            .reverse()
            // 7. Flatten transactions
            .reduce((flat, it) => flat.concat(it), []);

        // 8. Then map to plain objects
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

        return {
            newTransactions: txs,
            // removedTransactions: removedTxs,
            wasRateLimited,
        };
    }

    async requestTransactionReceipts(address) {
        await this._consensusEstablished;
        return this._client.getTransactionReceiptsByAddress(address);
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
            (await this._client._consensus).mempool.removeTransaction(tx);
        } catch (e) { console.warn(e); }
        return true;
    }

    async _bindEvents() {
        this._client.addConsensusChangedListener(state => {
            switch (state) {
                case Nimiq.Client.ConsensusState.CONNECTING:
                    this._consensusLost(); break;
                case Nimiq.Client.ConsensusState.SYNCING:
                    this._onConsensusSyncing(); break;
                case Nimiq.Client.ConsensusState.ESTABLISHED:
                    this.__consensusEstablished(); break;
            }
        });

        this._client.addHeadChangedListener(this._headChanged.bind(this));

        (await this._client._consensus).on('transaction-relayed', tx => this._transactionRelayed(tx));
        (await this._client._consensus).network.on('peers-changed', () => this._onPeersChanged());
    }

    async _headChanged() {
        if (!this._isConsensusEstablished) return;

        const header = (await this._client.getHeadBlock(false)).header;

        if (this._knownHead && this._knownHead.equals(header)
            || this._knownHead && this._knownHead.height > header.height) {
            // Known or outdated head. Note that this currently doesn't handle rebranches well.
            return;
        }
        const isFirstHead = !this._knownHead;
        this._knownHead = header;
        this._onHeadChange(header);
        // no need to recheck balances when we just reached consensus
        // because subscribe() already queued it
        if (isFirstHead) return;
        this._recheckBalances();
    }

    /**
     * @returns {Promise<Account[]>} An array element can be NULL if account does not exist
     */
    async _getAccounts(addresses) {
        if (!addresses.length) return [];
        await this._consensusEstablished;

        return this._client.getAccounts(addresses);
    }

    /**
     * @param {string[]} addresses
     * @returns {Promise<Map<string, number>>}
     */
    async _getBalances(addresses) {
        let accounts = await this._getAccounts(addresses);

        const balances = new Map();

        await Promise.all(accounts.map(async (account, i) => {
            const address = addresses[i];
            let balance = 0;
            if (account) {
                balance = Math.max(0, Nimiq.Policy.satoshisToCoins(account.balance) + (await this._getPendingAmount(address)));
            }
            balances.set(address, balance);
        }));

        return balances;
    }

    __consensusEstablished() {
        this._isConsensusEstablished = true;
        this._consensusEstablishedResolver();
        this._onConsensusEstablished();
    }

    _consensusLost() {
        if (this._isConsensusEstablished) {
            // Only replace _consensusEstablished promise when it was resolved,
            // as other methods are awaiting that promise and when it gets replaced,
            // those methods hang forever.
            this._createConsensusPromise();
            this._isConsensusEstablished = false;
        }
        this._onConsensusLost();
    }

    _onTransaction(txDetails) {
        switch (txDetails.state) {
            case Nimiq.Client.TransactionState.NEW:
            case Nimiq.Client.TransactionState.PENDING:
                this._transactionAdded(txDetails.transaction);
                break;
            case Nimiq.Client.TransactionState.MINED:
                this._transactionMined(txDetails.transaction, {height: txDetails.blockHeight, timestamp: txDetails.timestamp});
                break;
            case Nimiq.Client.TransactionState.INVALIDATED:
            case Nimiq.Client.TransactionState.EXPIRED:
                this._transactionExpired(txDetails.transaction);
                break;
            case Nimiq.Client.TransactionState.CONFIRMED:
                break;
        }
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
                // Balance did not change since last check.
                // Remove from balances Map to not send this balance in the balances-changed event.
                balances.delete(address);
                continue;
            }

            // Update balances cache
            this._balances.set(address, balance);
        }

        if (balances.size) this._onBalancesChanged(balances);
    }

    async _getPendingAmount(address) {
        const addr = Nimiq.Address.fromUserFriendlyAddress(address);
        try {
            const txs = await (await this._client._consensus).getPendingTransactionsByAddress(addr);
            const pendingAmount = txs.reduce(
                // Only add the amount to the pending amount when the transaction is outgoing (-1),
                // not when it's an incoming transaction (0).
                (acc, tx) => acc + (Nimiq.Policy.satoshisToCoins(tx.value + tx.fee) * (tx.sender.equals(addr) ? -1 : 0)),
                0,
            );
            return pendingAmount;
        } catch (err) {
            return 0;
        }
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

    async _onPeersChanged() {
        const statistics = await this._client.network.getStatistics();
        const peerCount = statistics.totalPeerCount;
        // console.log('peers changed:', peerCount);
        this.fire('nimiq-peer-count', peerCount);
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
