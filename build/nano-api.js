import { Utf8Tools } from '@nimiq/utils';
export class NanoNetworkApi {
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
            // setTimeout(resolve, 500);
            this.onInitialized();
            resolve();
        });
        this.createConsensusPromise();
        this._selfRelayedTransactionHashes = new Set();
        this._balances = new Map();
    }
    get apiUrl() { return this._config.cdn; }
    fire(event, data) {
        throw new Error('The fire() method needs to be overloaded!');
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
        this._consensus.blockchain.on('head-changed', block => this._headChanged(block.header));
        this._consensus.mempool.on('transaction-added', tx => this.transactionAdded(tx));
        this._consensus.mempool.on('transaction-expired', tx => this.transactionExpired(tx));
        this._consensus.mempool.on('transaction-mined', (tx, header) => this.transactionMined(tx, header));
        this._consensus.network.on('peers-changed', () => this.onPeersChanged());
        return true;
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
        const account = (await this._getAccounts([address]))[0];
        if (!account)
            return 'basic';
        // See Nimiq.Account.Type
        switch (account.type) {
            case Nimiq.Account.Type.BASIC: return 'basic';
            case Nimiq.Account.Type.VESTING: return 'vesting';
            case Nimiq.Account.Type.HTLC: return 'htlc';
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
    async _headChanged(header) {
        if (!this._consensus.established)
            return;
        this.recheckBalances();
        this.onHeadChange(header);
    }
    async _getAccounts(addresses, stackHeight = 0) {
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
                    resolve(await this._getAccounts(addresses, stackHeight));
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
        let accounts = await this._getAccounts(addresses);
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
        this._headChanged(this._consensus.blockchain.head);
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
        if (balances.size)
            this.onBalancesChanged(balances);
    }
    getPendingAmount(address) {
        const txs = this._consensus.mempool.getPendingTransactions(Nimiq.Address.fromUserFriendlyAddress(address));
        const pendingAmount = txs.reduce((acc, tx) => acc + Nimiq.Policy.satoshisToCoins(tx.value + tx.fee), 0);
        return pendingAmount;
    }
    async createBasicTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey));
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = parseInt(obj.validityStartHeight);
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));
        return new Nimiq.BasicTransaction(senderPubKey, recipientAddr, value, fee, validityStartHeight, signature);
    }
    async createExtendedTransactionFromObject(obj) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey));
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
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey));
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
    onBalancesChanged(balances) {
        // console.log('new balances:', balances);
        this.fire('nimiq-balances', balances);
    }
    onTransactionPending(sender, recipient, value, fee, extraData, hash, validityStartHeight) {
        this.fire('nimiq-transaction-pending', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
    }
    onTransactionExpired(hash) {
        this.fire('nimiq-transaction-expired', hash);
    }
    onTransactionMined(sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, // FIXME add type 
    validityStartHeight) {
        // console.log('mined:', { sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, validityStartHeight });
        this.fire('nimiq-transaction-mined', { sender, recipient, value, fee, extraData, hash, blockHeight, timestamp, validityStartHeight });
    }
    onTransactionRelayed(sender, recipient, value, fee, extraData, hash, validityStartHeight) {
        console.log('relayed:', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
        this.fire('nimiq-transaction-relayed', { sender, recipient, value, fee, extraData, hash, validityStartHeight });
    }
    onInitializationError(e) {
        console.error('Nimiq API could not be initialized:', e);
        this.fire('nimiq-api-fail', e);
    }
    onHeadChange(header) {
        this.fire('nimiq-head-change', {
            height: header.height,
            globalHashrate: this.globalHashrate(header.difficulty)
        });
    }
    onPeersChanged() {
        this.fire('nimiq-peer-count', this._consensus.network.peerCount);
    }
    importApi() {
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
//# sourceMappingURL=nano-api.js.map