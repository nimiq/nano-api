import { Utf8Tools } from '@nimiq/utils';
export var Events;
(function (Events) {
    Events["API_READY"] = "nimiq-api-ready";
    Events["API_FAIL"] = "nimiq-api-fail";
    Events["CONSENSUS_SYNCING"] = "nimiq-consensus-syncing";
    Events["CONSENSUS_ESTABLISHED"] = "nimiq-consensus-established";
    Events["CONSENSUS_LOST"] = "nimiq-consensus-lost";
    Events["PEERS_CHANGED"] = "nimiq-peer-count";
    Events["BALANCES_CHANGED"] = "nimiq-balances";
    Events["TRANSACTION_PENDING"] = "nimiq-transaction-pending";
    Events["TRANSACTION_EXPIRED"] = "nimiq-transaction-expired";
    Events["TRANSACTION_MINED"] = "nimiq-transaction-mined";
    Events["TRANSACTION_RELAYED"] = "nimiq-transaction-relayed";
    Events["HEAD_CHANGE"] = "nimiq-head-change";
})(Events || (Events = {}));
export var AccountType;
(function (AccountType) {
    AccountType["BASIC"] = "basic";
    AccountType["HTLC"] = "htlc";
    AccountType["VESTING"] = "vesting";
})(AccountType || (AccountType = {}));
export class NanoApi {
    constructor(config) {
        this._config = config;
        this._apiInitialized = new Promise(async (resolve) => {
            await this.importApi();
            try {
                await Nimiq.load();
            }
            catch (e) {
                this.onInitializationError(e.message || e);
                return; // Do not resolve promise
            }
            this.onInitialized();
            resolve();
        });
        this.createConsensusPromise();
        this._selfRelayedTransactionHashes = new Set();
        this._balances = new Map();
    }
    async connect() {
        await this._apiInitialized;
        try {
            Nimiq.GenesisConfig[this._config.network]();
        }
        catch (e) { }
        // Uses volatileNano to enable more than one parallel network iframe
        this._consensus = await Nimiq.Consensus.volatileNano();
        this._consensus.on('syncing', e => this.onConsensusSyncing());
        this._consensus.on('established', e => this.__consensusEstablished());
        this._consensus.on('lost', e => this.consensusLost());
        this._consensus.on('transaction-relayed', tx => this.transactionRelayed(tx));
        this._consensus.network.connect();
        this._consensus.blockchain.on('head-changed', block => this.headChanged(block.header));
        this._consensus.mempool.on('transaction-added', tx => this.transactionAdded(tx));
        this._consensus.mempool.on('transaction-expired', tx => this.transactionExpired(tx));
        this._consensus.mempool.on('transaction-mined', (tx, header) => this.transactionMined(tx, header));
        this._consensus.network.on('peers-changed', () => this.onPeersChanged());
        return true;
    }
    async relayTransaction(txObj) {
        await this._consensusEstablished;
        let tx;
        if (typeof txObj.extraData === 'string') {
            txObj.extraData = Utf8Tools.stringToUtf8ByteArray(txObj.extraData);
        }
        if (txObj.isVesting) {
            tx = await this.createVestingTransactionFromObject(txObj);
        }
        else if (txObj.extraData && txObj.extraData.length > 0) {
            tx = await this.createExtendedTransactionFromObject(txObj);
        }
        else {
            tx = await this.createBasicTransactionFromObject(txObj);
        }
        this._selfRelayedTransactionHashes.add(tx.hash().toBase64());
        this._consensus.relayTransaction(tx);
        return true;
    }
    async getTransactionSize(txObj) {
        await this._apiInitialized;
        let tx;
        if (txObj.extraData && txObj.extraData.length > 0) {
            tx = await this.createExtendedTransactionFromObject(txObj);
        }
        else {
            tx = await this.createBasicTransactionFromObject(txObj);
        }
        return tx.serializedSize;
    }
    async subscribe(addresses) {
        if (!(addresses instanceof Array))
            addresses = [addresses];
        this.subscribeAddresses(addresses);
        this.recheckBalances(addresses);
        return true;
    }
    async getBalance(addresses) {
        if (!(addresses instanceof Array))
            addresses = [addresses];
        const balances = await this.getBalances(addresses);
        for (const [address, balance] of balances) {
            this._balances.set(address, balance);
        }
        return balances;
    }
    async getAccountTypeString(address) {
        const account = (await this.getAccounts([address]))[0];
        if (!account)
            return AccountType.BASIC;
        // See Nimiq.Account.Type
        switch (account.type) {
            case Nimiq.Account.Type.BASIC: return AccountType.BASIC;
            case Nimiq.Account.Type.VESTING: return AccountType.VESTING;
            case Nimiq.Account.Type.HTLC: return AccountType.HTLC;
            default: return false;
        }
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
                const vestingContract = account;
                contracts.push({
                    address: address.toUserFriendlyAddress(),
                    // balance: Nimiq.Policy.satoshisToCoins(account.balance),
                    owner: vestingContract.owner.toUserFriendlyAddress(),
                    start: vestingContract.vestingStart,
                    stepAmount: Nimiq.Policy.satoshisToCoins(vestingContract.vestingStepAmount),
                    stepBlocks: vestingContract.vestingStepBlocks,
                    totalAmount: Nimiq.Policy.satoshisToCoins(vestingContract.vestingTotalAmount)
                });
            }
        }
        return contracts;
    }
    async removeTxFromMempool(txObj) {
        const tx = await this.createBasicTransactionFromObject(txObj);
        this._consensus.mempool.removeTransaction(tx);
        return true;
    }
    async requestTransactionHistory(addresses, knownReceipts, fromHeight) {
        if (!(addresses instanceof Array))
            addresses = [addresses];
        let results = await Promise.all(addresses.map(address => this._requestTransactionHistory(address, knownReceipts.get(address), fromHeight)));
        // txs is an array of objects of arrays, which have the format {transaction: Nimiq.Transaction, header: Nimiq.BlockHeader}
        // We need to reduce this to usable simple tx objects
        // Construct arrays with their relavant information
        let txs = results.map(r => r.transactions);
        let removedTxs = results.map(r => r.removedTxHashes);
        let unresolvedTxs = results.map(r => r.unresolvedReceipts);
        // First, reduce
        const reducedTxs = txs.reduce((flat, it) => it ? flat.concat(it) : flat, []);
        const reducedRemovedTxs = removedTxs.reduce((flat, it) => it ? flat.concat(it) : flat, []);
        const reducedUnresolvedTxs = unresolvedTxs.reduce((flat, it) => it ? flat.concat(it) : flat, []);
        // Then map to simple objects
        let plainTransactions = reducedTxs.map(tx => ({
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
        const _txHashes = plainTransactions.map(tx => tx.hash);
        plainTransactions = plainTransactions.filter((tx, index) => {
            return _txHashes.indexOf(tx.hash) === index;
        });
        return {
            newTransactions: plainTransactions,
            removedTransactions: reducedRemovedTxs,
            unresolvedTransactions: reducedUnresolvedTxs,
        };
    }
    async requestTransactionReceipts(address) {
        const addressBuffer = Nimiq.Address.fromUserFriendlyAddress(address);
        // @ts-ignore _requestTransactionReceipts is private currently
        return this._consensus._requestTransactionReceipts(addressBuffer);
    }
    fire(event, data) {
        throw new Error('The fire() method needs to be overloaded!');
    }
    get apiUrl() { return this._config.cdn; }
    async _requestTransactionHistory(address, knownReceipts = new Map(), fromHeight = 0) {
        await this._consensusEstablished;
        const addressBuffer = Nimiq.Address.fromUserFriendlyAddress(address);
        // Inpired by Nimiq.BaseConsensus._requestTransactionHistory()
        // 1. Get transaction receipts.
        let receipts = null;
        let retryCounter = 1;
        while (!(receipts instanceof Array)) {
            // Return after the 3rd try
            if (retryCounter >= 4)
                return {
                    transactions: [],
                    removedTxHashes: [],
                    unresolvedReceipts: []
                };
            try {
                // @ts-ignore _requestTransactionReceipts is private currently
                receipts = await this._consensus._requestTransactionReceipts(addressBuffer);
            }
            catch (e) {
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
        }
        else {
            const receiptTxHashes = receipts.map(r => r.transactionHash.toBase64());
            removedTxHashes = knownTxHashes.filter(knownTxHash => !receiptTxHashes.includes(knownTxHash));
        }
        // 2b. Filter out known receipts.
        receipts = receipts.filter(receipt => {
            if (receipt.blockHeight < fromHeight)
                return false;
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
            // FIXME remove cast after fix in core types
            if (!receipt.blockHash.equals(lastBlockHash)) {
                // eslint-disable-next-line no-await-in-loop
                // @ts-ignore private method access
                const block = await this._consensus._blockchain.getBlock(receipt.blockHash);
                if (block) {
                    blockRequests.push(Promise.resolve(block));
                }
                else {
                    // @ts-ignore private method access
                    const request = this._consensus._requestBlockProof(receipt.blockHash, receipt.blockHeight)
                        .catch((e) => {
                        unresolvedReceipts.push(receipt);
                        console.error(NanoApi, `Failed to retrieve proof for block ${receipt.blockHash}`
                            + ` (${e}) - transaction history may be incomplete`);
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
            if (!block)
                continue;
            // @ts-ignore private method access
            const request = this._consensus._requestTransactionsProof([addressBuffer], block)
                .then((txs) => txs.map((tx) => ({ transaction: tx, header: block.header })))
                .catch((e) => console.error(NanoApi, `Failed to retrieve transactions for block ${block.hash()}`
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
    async headChanged(header) {
        if (!this._consensus.established)
            return;
        this.recheckBalances();
        this.onHeadChange(header);
    }
    async getAccounts(addresses, stackHeight = 0) {
        if (addresses.length === 0)
            return [];
        await this._consensusEstablished;
        let accounts;
        const addressesAsAddresses = addresses.map(address => Nimiq.Address.fromUserFriendlyAddress(address));
        try {
            accounts = await this._consensus.getAccounts(addressesAsAddresses);
        }
        catch (e) {
            stackHeight++;
            return await new Promise(resolve => {
                const timeout = 1000 * stackHeight;
                setTimeout(async (_) => {
                    resolve(await this.getAccounts(addresses, stackHeight));
                }, timeout);
                console.warn(`Could not retrieve accounts from consensus, retrying in ${timeout / 1000} s`);
            });
        }
        return accounts;
    }
    async subscribeAddresses(addresses) {
        const addressesAsAddresses = addresses.map(address => Nimiq.Address.fromUserFriendlyAddress(address));
        await this._consensusEstablished;
        this._consensus.subscribeAccounts(addressesAsAddresses);
    }
    async getBalances(addresses) {
        let accounts = await this.getAccounts(addresses);
        const balances = new Map();
        accounts.forEach((account, i) => {
            const address = addresses[i];
            const balance = account ? Nimiq.Policy.satoshisToCoins(account.balance) : 0;
            balances.set(address, balance);
        });
        return balances;
    }
    __consensusEstablished() {
        this._consensusEstablishedResolver();
        this.headChanged(this._consensus.blockchain.head);
        this.onConsensusEstablished();
    }
    consensusLost() {
        this.createConsensusPromise();
        this.onConsensusLost();
    }
    transactionAdded(tx) {
        const hash = tx.hash().toBase64();
        if (this._selfRelayedTransactionHashes.has(hash))
            return;
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();
        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this.recheckBalances(senderAddr);
        this.onTransactionPending(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), tx.data, hash, tx.validityStartHeight);
    }
    transactionExpired(tx) {
        const senderAddr = tx.sender.toUserFriendlyAddress();
        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this.recheckBalances(senderAddr);
        this.onTransactionExpired(tx.hash().toBase64());
    }
    transactionMined(tx, header) {
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();
        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this.recheckBalances(senderAddr);
        this.onTransactionMined(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), tx.data, tx.hash().toBase64(), header.height, header.timestamp, tx.validityStartHeight);
    }
    transactionRelayed(tx) {
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();
        // Handle tx amount when the sender is own account
        this._balances.has(senderAddr) && this.recheckBalances(senderAddr);
        this.onTransactionRelayed(senderAddr, recipientAddr, Nimiq.Policy.satoshisToCoins(tx.value), Nimiq.Policy.satoshisToCoins(tx.fee), tx.data, tx.hash().toBase64(), tx.validityStartHeight);
    }
    createConsensusPromise() {
        this._consensusEstablished = new Promise(resolve => {
            this._consensusEstablishedResolver = resolve;
        });
    }
    globalHashrate(difficulty) {
        return Math.round((difficulty * Math.pow(2, 16) / Nimiq.Policy.BLOCK_TIME));
    }
    async recheckBalances(addresses = [...this._balances.keys()]) {
        if (!(addresses instanceof Array))
            addresses = [addresses];
        const balances = await this.getBalances(addresses);
        for (let [address, balance] of balances) {
            balance -= this.getPendingAmount(address);
            if (this._balances.get(address) === balance) {
                balances.delete(address);
                continue;
            }
            balances.set(address, balance);
            this._balances.set(address, balance);
        }
        if (balances.size) {
            this.onBalancesChanged(balances);
        }
    }
    getPendingAmount(address) {
        const txs = this._consensus.mempool.getPendingTransactions(Nimiq.Address.fromUserFriendlyAddress(address));
        const pendingAmount = txs.reduce((acc, tx) => acc + Nimiq.Policy.satoshisToCoins(tx.value + tx.fee), 0);
        return pendingAmount;
    }
    async createBasicTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey || obj.signerPublicKey));
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));
        return new Nimiq.BasicTransaction(senderPubKey, recipientAddr, value, fee, validityStartHeight, signature);
    }
    async createExtendedTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey || obj.signerPublicKey));
        const senderAddr = senderPubKey.toAddress();
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));
        const data = obj.extraData;
        const proof = Nimiq.SignatureProof.singleSig(senderPubKey, signature);
        const serializedProof = proof.serialize();
        return new Nimiq.ExtendedTransaction(senderAddr, Nimiq.Account.Type.BASIC, recipientAddr, Nimiq.Account.Type.BASIC, value, fee, validityStartHeight, Nimiq.Transaction.Flag.NONE, data, serializedProof);
    }
    async createVestingTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey || obj.signerPublicKey));
        const recipientAddr = senderPubKey.toAddress();
        const senderAddr = Nimiq.Address.fromUserFriendlyAddress(obj.sender);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));
        const data = obj.extraData;
        const proof = Nimiq.SignatureProof.singleSig(senderPubKey, signature);
        const serializedProof = proof.serialize();
        return new Nimiq.ExtendedTransaction(senderAddr, Nimiq.Account.Type.VESTING, recipientAddr, Nimiq.Account.Type.BASIC, value, fee, validityStartHeight, Nimiq.Transaction.Flag.NONE, data, serializedProof);
    }
    onInitialized() {
        this.fire(Events.API_READY);
    }
    onConsensusSyncing() {
        console.log('consensus syncing');
        this.fire(Events.CONSENSUS_SYNCING);
    }
    onConsensusEstablished() {
        console.log('consensus established');
        this.fire(Events.CONSENSUS_ESTABLISHED);
    }
    onConsensusLost() {
        console.log('consensus lost');
        this.fire(Events.CONSENSUS_LOST);
    }
    onBalancesChanged(balances) {
        // console.log('new balances:', balances);
        this.fire(Events.BALANCES_CHANGED, balances);
    }
    onTransactionPending(sender, recipient, value, fee, extraData, hash, validityStartHeight) {
        this.fire(Events.TRANSACTION_PENDING, { sender, recipient, value, fee, extraData, hash, validityStartHeight });
    }
    onTransactionExpired(hash) {
        this.fire(Events.TRANSACTION_EXPIRED, hash);
    }
    onTransactionMined(sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, // FIXME add type
    validityStartHeight) {
        // console.log('mined:', { sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, validityStartHeight });
        this.fire(Events.TRANSACTION_MINED, { sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, validityStartHeight });
    }
    onTransactionRelayed(sender, recipient, value, fee, extraData, hash, validityStartHeight) {
        console.log('relayed:', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
        this.fire(Events.TRANSACTION_RELAYED, { sender, recipient, value, fee, extraData, hash, validityStartHeight });
    }
    onInitializationError(e) {
        console.error('Nimiq API could not be initialized:', e);
        this.fire(Events.API_FAIL, e);
    }
    onHeadChange(header) {
        this.fire(Events.HEAD_CHANGE, {
            height: header.height,
            globalHashrate: this.globalHashrate(header.difficulty)
        });
    }
    onPeersChanged() {
        this.fire(Events.PEERS_CHANGED, this._consensus.network.peerCount);
    }
    async importApi() {
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
//# sourceMappingURL=NanoApi.js.map