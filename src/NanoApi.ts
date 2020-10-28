import { Utf8Tools } from '@nimiq/utils';

interface Config {
    cdn: string,
    network: 'test' | 'main',
}

type TransactionObjectIn = {
    sender: string,
    senderType?: Nimiq.Account.Type,
    recipient: string,
    recipientType?: Nimiq.Account.Type,
    value: number,
    fee: number,
    validityStartHeight: number | string,
    extraData?: string | Uint8Array,
    flags?: Nimiq.Transaction.Flag,
    proof?: Uint8Array,

    senderPubKey?: Uint8Array,
    signerPublicKey?: Uint8Array,
    signature: Uint8Array,
};

type TransactionObjectOut = {
    sender: string,
    recipient: string,
    value: number,
    fee: number,
    validityStartHeight: number,
    extraData: string | Uint8Array,
    hash: string,
    blockHeight: number,
    blockHash: string,
    timestamp: number,
};

type VestingContractOut = {
    address: string;
    owner: any;
    start: any;
    stepAmount: number;
    stepBlocks: any;
    totalAmount: number;
};

type PlainTransaction = ReturnType<Nimiq.Transaction["toPlain"]>;
type PlainTransactionReceipt = ReturnType<Nimiq.TransactionReceipt["toPlain"]>;
type PlainTransactionDetails = ReturnType<Nimiq.Client.TransactionDetails["toPlain"]>;
type PlainVestingContract = ReturnType<Nimiq.VestingContract["toPlain"]> & {
    address: string,
};

type Balances = Map<string, number>;

export class NanoApi {
    private _config: Config;
    private _consensusEstablished!: Promise<boolean>;
    private _apiInitialized: Promise<boolean>;
    private _consensusEstablishedResolver!: () => any;
    private _isConsensusEstablished = false;
    private _selfRelayedTransactionHashes = new Set<string>();
    private _balances: Balances = new Map<string, number>(); // Balances in Luna, excluding pending txs
    private _compatBalances: Balances = new Map<string, number>(); // Balances in NIM, including pending txs
    private _knownHead: Nimiq.BlockHeader | null = null;
    private _client!: Nimiq.Client;

    constructor(config: Config) {
        this._config = config;
        this._apiInitialized = new Promise(async (resolve) => {
            await this._importApi();
            try {
                await Nimiq.load();
            } catch (e) {
                console.error('Nimiq API could not be initialized:', e.message || e);
                this.fire('nimiq-api-fail', e.message || e);
                return; // Do not resolve promise
            }
            // setTimeout(resolve, 500);
            // console.log('Nimiq API ready to use');
            this.fire('nimiq-api-ready');
            resolve();
        });

        this._createConsensusPromise();
    }

    get apiUrl() { return this._config.cdn }

    // @ts-ignore 'event' is declared but its value is never read. 'data' is declared but its value is never read.
    fire(event: string, data?: any) {
        throw new Error('The fire() method needs to be overloaded!');
    }

    async getPeerAddresses() {
        await this._apiInitialized;
        const peerAddressInfos = await this._client.network.getAddresses();
        return peerAddressInfos.map(addressInfo => addressInfo.toPlain());
    }

    async relayTransaction(txObj: TransactionObjectIn): Promise<PlainTransactionDetails> {
        let isTxSent = false;
        let mustWaitBeforeRelay = !this._isConsensusEstablished;

        await this._consensusEstablished;

        const tx = await this._createTransactionFromObject(txObj);
        // console.log("Debug: transaction size was:", tx.serializedSize);
        this._selfRelayedTransactionHashes.add(tx.hash().toBase64());

        let txDetails: Nimiq.Client.TransactionDetails;
        let attempts = 0;
        while (!isTxSent) {
            // Wait 1s before sending the transaction so that peers can announce their mempool service to us
            if (mustWaitBeforeRelay) await new Promise(res => setTimeout(res, 1000));

            txDetails = await this._client.sendTransaction(tx);

            if (txDetails.state === Nimiq.Client.TransactionState.INVALIDATED) {
                throw new Error('Transaction is invalid');
            }

            isTxSent = txDetails.state === Nimiq.Client.TransactionState.PENDING ||
                       txDetails.state === Nimiq.Client.TransactionState.MINED;

            mustWaitBeforeRelay = true;
            if (++attempts === 3) break;
        }

        return txDetails!.toPlain();
    }

    async getTransactionSize(txObj: TransactionObjectIn): Promise<number> {
        await this._apiInitialized;
        const tx = await this._createTransactionFromObject(txObj);
        return tx.serializedSize;
    }

    async connect(): Promise<Nimiq.Client | undefined> {
        await this._apiInitialized;

        try {
            Nimiq.GenesisConfig[this._config.network]();
        } catch (e) {
            console.warn('Already connected');
            return;
        }

        this._client = Nimiq.Client.Configuration.builder().volatile().instantiateClient();

        this._bindEventListeners();

        return this._client;
    }

    async subscribe(addresses: string | string[]): Promise<true> {
        if (!(addresses instanceof Array)) addresses = [addresses];
        await this._apiInitialized;
        this._client.addTransactionListener(this._onTransaction.bind(this), addresses);
        this._recheckBalances(addresses);
        return true;
    }

    async addTransactionListener(eventName: string, addresses: string[]): Promise<number> {
        if (!(addresses instanceof Array)) addresses = [addresses];
        await this._apiInitialized;
        const listener = (tx: Nimiq.Client.TransactionDetails) => this.fire(eventName, tx.toPlain());
        return this._client.addTransactionListener(listener, addresses);
    }

    async removeListener(handle: number): Promise<void> {
        await this._apiInitialized;
        return this._client.removeListener(handle);
    }

    async getBalance(addresses: string | string[]): Promise<Balances> {
        if (!(addresses instanceof Array)) addresses = [addresses];

        const balances = (await this._getBalances(addresses)).compat;
        for (const [address, balance] of balances) { this._compatBalances.set(address, balance); }

        return balances;
    }

    // To support un-updated client code
    async connectPico(addresses: string | string[]) {
        console.warn('connectPico() is deprecated. Use getBalance() instead.');
        return this.getBalance(addresses);
    }

    async getAccountTypeString(address: string): Promise<string> {
        const account = (await this._getAccounts([address]))[0];
        return Nimiq.Account.Type.toString(account.type as Nimiq.Account.Type);
    }

    async requestTransactionHistory(
        addresses: string | string[],
        knownReceipts = new Map<string, string>(),
        fromHeight = 0
    ): Promise<{newTransactions: TransactionObjectOut[], wasRateLimited: boolean}> {
        if (!(addresses instanceof Array)) addresses = [addresses];
        await this._consensusEstablished;

        const newReceiptsMap = new Map<string, Nimiq.TransactionReceipt>();
        const knownReceiptHashes = new Set([...knownReceipts.entries()].map(entry => entry[0] + entry[1]));

        let wasRateLimited = false;

        // 1. Get all receipts for all addresses, flattened, only unknowns, unique
        (await Promise.all(addresses.map(address => this._client
            .getTransactionReceiptsByAddress(address)
            .catch(() => {
                wasRateLimited = true;
                return [] as Nimiq.TransactionReceipt[];
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
        const newBlocks = new Map<string, Nimiq.TransactionReceipt[]>();
        for (const receipt of newReceipts) {
            const entry = newBlocks.get(receipt.blockHash.toPlain());
            if (entry) {
                // The entry is updated in the map by reference.
                entry.push(receipt);
            } else {
                newBlocks.set(receipt.blockHash.toPlain(), [receipt]);
            }
        }

        // 4. Fetch all required blocks (and allow fetching to fail)
        /** @type {Map<string, Promise<Nimiq.Block | null>>} */
        const blocks = new Map([...newBlocks.keys()].map((blockHash: string) => [blockHash, this._client
            .getBlock(blockHash, true)
            .catch(() => {
                wasRateLimited = true;
                return null;
            }),
        ]));

        let txs =
            // 5. Fetch required transactions from the blocks
            (await Promise.all([...newBlocks.entries()].map(async ([blockHash, receipts]: [string, Nimiq.TransactionReceipt[]]) => {
                const block = await blocks.get(blockHash);
                if (!block) return [];

                const txHashes = receipts.map(receipt => receipt.transactionHash);

                // @ts-ignore Property '_consensus' does not exist on type 'Client'.
                const consensus = await this._client._consensus as Nimiq.PicoConsensus;
                const txs = await consensus
                    .getTransactionsFromBlock(txHashes, Nimiq.Hash.fromPlain(blockHash), block.height, block)
                    .catch(() => {
                        wasRateLimited = true;
                        return [] as Nimiq.Transaction[];
                    });
                return txs.map(tx => ({ transaction: tx, header: block.header }));
            })))
            // 6. Reverse array, so that oldest transactions are first
            .reverse()
            // 7. Flatten transactions
            .reduce((flat, it) => flat.concat(it), []);

        // 8. Then map to plain objects
        const newTransactions: TransactionObjectOut[] = txs.map(tx => ({
            sender: tx.transaction.sender.toUserFriendlyAddress(),
            recipient: tx.transaction.recipient.toUserFriendlyAddress(),
            value: Nimiq.Policy.satoshisToCoins(tx.transaction.value),
            fee: Nimiq.Policy.satoshisToCoins(tx.transaction.fee),
            extraData: tx.transaction.data,
            hash: tx.transaction.hash().toBase64(),
            blockHeight: tx.header.height,
            blockHash: tx.header.hash().toBase64(),
            timestamp: tx.header.timestamp,
            validityStartHeight: tx.transaction.validityStartHeight,
        }));

        return {
            newTransactions,
            // removedTransactions: removedTxs,
            wasRateLimited,
        };
    }

    async requestTransactionReceipts(address: string, limit?: number): Promise<PlainTransactionReceipt[]> {
        await this._consensusEstablished;
        const receipts = await this._client.getTransactionReceiptsByAddress(address, limit);
        return receipts.map(r => r.toPlain());
    }

    async getGenesisVestingContracts(): Promise<VestingContractOut[]>
    async getGenesisVestingContracts(modern: true): Promise<PlainVestingContract[]> // MODERN
    async getGenesisVestingContracts(modern?: boolean): Promise<(VestingContractOut|PlainVestingContract)[]> {
        await this._apiInitialized;
        const contracts: (VestingContractOut|PlainVestingContract)[] = [];
        const buf = Nimiq.BufferUtils.fromBase64(Nimiq.GenesisConfig.GENESIS_ACCOUNTS);
        const count = buf.readUint16();
        for (let i = 0; i < count; i++) {
            const address = Nimiq.Address.unserialize(buf);
            const account = Nimiq.Account.unserialize(buf);

            if (account.type === Nimiq.Account.Type.VESTING) {
                const contract = account as Nimiq.VestingContract;
                contracts.push(modern ? {
                    address: address.toUserFriendlyAddress(),
                    ...contract.toPlain(),
                 } : {
                    address: address.toUserFriendlyAddress(),
                    // balance: Nimiq.Policy.satoshisToCoins(account.balance),
                    owner: contract.owner.toUserFriendlyAddress(),
                    start: contract.vestingStart,
                    stepAmount: Nimiq.Policy.satoshisToCoins(contract.vestingStepAmount),
                    stepBlocks: contract.vestingStepBlocks,
                    totalAmount: Nimiq.Policy.satoshisToCoins(contract.vestingTotalAmount)
                });
            }
        }
        return contracts;
    }

    async removeTxFromMempool(txObj: TransactionObjectIn): Promise<true> {
        const tx = await this._createTransactionFromObject(txObj);
        try {
            // @ts-ignore Property '_consensus' does not exist on type 'Client'.
            (await this._client._consensus as Nimiq.PicoConsensus).mempool.removeTransaction(tx);
        } catch (e) { console.warn(e); }
        return true;
    }

    async _bindEventListeners(): Promise<void> {
        this._client.addConsensusChangedListener(state => {
            this.fire('consensus', state); // MODERN

            switch (state) {
                case Nimiq.Client.ConsensusState.CONNECTING:
                    if (this._isConsensusEstablished) {
                        // Only replace _consensusEstablished promise when it was resolved,
                        // as other methods are awaiting that promise and when it gets replaced,
                        // those methods hang forever.
                        this._createConsensusPromise();
                        this._isConsensusEstablished = false;
                    }
                    console.log('Consensus lost');
                    this.fire('nimiq-consensus-lost');
                    break;
                case Nimiq.Client.ConsensusState.SYNCING:
                    console.log('Consensus syncing');
                    this.fire('nimiq-consensus-syncing');
                    break;
                case Nimiq.Client.ConsensusState.ESTABLISHED:
                    this._isConsensusEstablished = true;
                    this._consensusEstablishedResolver();
                    console.log('Consensus established');
                    this.fire('nimiq-consensus-established');
                    break;
            }
        });

        this._client.addHeadChangedListener(this._headChanged.bind(this));

        // @ts-ignore Property '_consensus' does not exist on type 'Client'.
        (await this._client._consensus as Nimiq.PicoConsensus).on('transaction-relayed', (tx: Nimiq.Transaction) => this._transactionRelayed(tx));
        // @ts-ignore Property '_consensus' does not exist on type 'Client'.
        (await this._client._consensus as Nimiq.PicoConsensus).network.on('peers-changed', () => this._onPeersChanged());
        // @ts-ignore Property '_consensus' does not exist on type 'Client'.
        (await this._client._consensus as Nimiq.PicoConsensus).network.addresses.on('added', (peerAddresses: Nimiq.PeerAddress[]) => this._onPeerAddressesAdded(peerAddresses));
    }

    async _headChanged(): Promise<void> {
        if (!this._isConsensusEstablished) return;

        const header = (await this._client.getHeadBlock(false)).header;

        if (this._knownHead && this._knownHead.equals(header)
            || this._knownHead && this._knownHead.height > header.height) {
            // Known or outdated head. Note that this currently doesn't handle rebranches well.
            return;
        }
        const isFirstHead = !this._knownHead;
        this._knownHead = header;

        this.fire('head-height', header.height); // MODERN

        // console.log('height changed:', header.height);
        this.fire('nimiq-head-change', {
            height: header.height,
            globalHashrate: this._calculateGlobalHashrate(header.difficulty),
        });

        // no need to recheck balances when we just reached consensus
        // because subscribe() already queued it
        if (isFirstHead) return;
        this._recheckBalances();
    }

    async _getAccounts(addresses: string[]): Promise<Nimiq.Account[]> {
        if (!addresses.length) return [];
        await this._consensusEstablished;

        return this._client.getAccounts(addresses);
    }

    async _getBalances(addresses: string[]): Promise<{
        balances: Balances,
        compat: Balances,
    }> {
        let accounts = await this._getAccounts(addresses);

        const balances: Balances = new Map();
        const compatBalances: Balances = new Map();

        await Promise.all(accounts.map(async (account, i) => {
            const address = addresses[i];
            balances.set(address, account.balance);

            let compatBalance = 0;
            if (account) {
                compatBalance = Math.max(0, Nimiq.Policy.satoshisToCoins(account.balance) + (await this._getPendingAmount(address)));
            }
            compatBalances.set(address, compatBalance);
        }));

        return {
            balances,
            compat: compatBalances,
        };
    }

    _onTransaction(txDetails: Nimiq.Client.TransactionDetails): void {
        this.fire('transaction', txDetails.toPlain()); // MODERN

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

    _transactionAdded(tx: Nimiq.Transaction): void {
        // Self-relayed transactions are added by the 'transaction-relayed' event
        const hash = tx.hash().toBase64();
        if (this._selfRelayedTransactionHashes.has(hash)) return;

        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        if (this._compatBalances.has(senderAddr)) {
            this._recheckBalances(senderAddr);
        }

        this.fire('nimiq-transaction-pending', {
            sender: senderAddr,
            recipient: recipientAddr,
            value: Nimiq.Policy.satoshisToCoins(tx.value),
            fee: Nimiq.Policy.satoshisToCoins(tx.fee),
            extraData: tx.data,
            hash,
            validityStartHeight: tx.validityStartHeight,
        } as TransactionObjectOut);
    }

    _transactionExpired(tx: Nimiq.Transaction): void {
        const senderAddr = tx.sender.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._compatBalances.has(senderAddr) && this._recheckBalances(senderAddr);

        // console.log('expired:', hash);
        this.fire('nimiq-transaction-expired', tx.hash().toBase64());
    }

    _transactionMined(tx: Nimiq.Transaction, header: {height: number, timestamp: number}): void {
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._compatBalances.has(senderAddr) && this._recheckBalances(senderAddr);

        this.fire('nimiq-transaction-mined', {
            sender: senderAddr,
            recipient: recipientAddr,
            value: Nimiq.Policy.satoshisToCoins(tx.value),
            fee: Nimiq.Policy.satoshisToCoins(tx.fee),
            extraData: tx.data,
            hash: tx.hash().toBase64(),
            blockHeight: header.height,
            timestamp: header.timestamp,
            validityStartHeight: tx.validityStartHeight,
        } as TransactionObjectOut);
    }

    _transactionRelayed(tx: Nimiq.Transaction): void {
        const senderAddr = tx.sender.toUserFriendlyAddress();
        const recipientAddr = tx.recipient.toUserFriendlyAddress();

        // Handle tx amount when the sender is own account
        this._compatBalances.has(senderAddr) && this._recheckBalances(senderAddr);

        this.fire('nimiq-transaction-relayed', {
            sender: senderAddr,
            recipient: recipientAddr,
            value: Nimiq.Policy.satoshisToCoins(tx.value),
            fee: Nimiq.Policy.satoshisToCoins(tx.fee),
            extraData: tx.data,
            hash: tx.hash().toBase64(),
            validityStartHeight: tx.validityStartHeight,
        } as TransactionObjectOut);
    }

    _createConsensusPromise(): void {
        this._consensusEstablished = new Promise(resolve => {
            this._consensusEstablishedResolver = resolve;
        });
    }

    _calculateGlobalHashrate(difficulty: Nimiq.BigNumber): number {
        return Math.round(+difficulty * Math.pow(2, 16) / Nimiq.Policy.BLOCK_TIME);
    }

    async _recheckBalances(addresses?: string | string[]) {
        if (!addresses) addresses = [...this._balances.keys()];
        if (!(addresses instanceof Array)) addresses = [addresses];

        const { balances, compat: compatBalances } = await this._getBalances(addresses);

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

        if (balances.size) {
            // console.log('new balances:', balances);
            this.fire('balances', balances); // MODERN
        }

        for (let [address, compatBalance] of compatBalances) {
            if (this._compatBalances.get(address) === compatBalance) {
                // Balance did not change since last check.
                // Remove from balances Map to not send this balance in the balances-changed event.
                compatBalances.delete(address);
                continue;
            }

            // Update balances cache
            this._compatBalances.set(address, compatBalance);
        }

        if (compatBalances.size) {
            // console.log('new balances:', balances);
            this.fire('nimiq-balances', compatBalances);
        }
    }

    async _getPendingAmount(address: string) {
        const addr = Nimiq.Address.fromUserFriendlyAddress(address);
        try {
            // @ts-ignore Property '_consensus' does not exist on type 'Client'. Expected 2 arguments, but got 1.
            const txs = await (await this._client._consensus as Nimiq.PicoConsensus).getPendingTransactionsByAddress(addr);
            const pendingAmount = txs.reduce(
                // Only add the amount to the pending amount when the transaction is outgoing (-1),
                // not when it's an incoming transaction (0).
                (acc: number, tx: Nimiq.Transaction) => acc + (Nimiq.Policy.satoshisToCoins(tx.value + tx.fee) * (tx.sender.equals(addr) ? -1 : 0)),
                0,
            );
            return pendingAmount;
        } catch (err) {
            return 0;
        }
    }

    async _createTransactionFromObject(txObj: TransactionObjectIn) {
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

    async _createBasicTransactionFromObject(obj: TransactionObjectIn) {
        await this._apiInitialized;
        const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey || obj.signerPublicKey));
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = typeof obj.validityStartHeight !== 'number'
            ? parseInt(obj.validityStartHeight, 10)
            : obj.validityStartHeight;
        const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));

        return new Nimiq.BasicTransaction(senderPubKey, recipientAddr, value, fee, validityStartHeight, signature);
    }

    async _createExtendedTransactionFromObject(obj: TransactionObjectIn) {
        await this._apiInitialized;
        const senderAddr = Nimiq.Address.fromUserFriendlyAddress(obj.sender);
        const senderType = obj.senderType || Nimiq.Account.Type.BASIC;
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(obj.recipient);
        const recipientType = obj.recipientType || Nimiq.Account.Type.BASIC;
        const value = Nimiq.Policy.coinsToSatoshis(obj.value);
        const fee = Nimiq.Policy.coinsToSatoshis(obj.fee);
        const validityStartHeight = typeof obj.validityStartHeight !== 'number'
            ? parseInt(obj.validityStartHeight, 10)
            : obj.validityStartHeight;
        const flags = obj.flags || Nimiq.Transaction.Flag.NONE;
        const data = obj.extraData as (Uint8Array | undefined) || new Uint8Array(0);
        let proof = obj.proof;

        if (!proof) {
            const senderPubKey = Nimiq.PublicKey.unserialize(new Nimiq.SerialBuffer(obj.senderPubKey || obj.signerPublicKey));
            const signature = Nimiq.Signature.unserialize(new Nimiq.SerialBuffer(obj.signature));
            proof = Nimiq.SignatureProof.singleSig(senderPubKey, signature).serialize();
        }

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
            proof,
        );
    }

    async _onPeersChanged() {
        const statistics = await this._client.network.getStatistics();
        const peerCount = statistics.totalPeerCount;
        // console.log('peers changed:', peerCount);
        this.fire('peer-count', peerCount); // MODERN
        this.fire('nimiq-peer-count', peerCount);
    }

    async _onPeerAddressesAdded(peerAddresses: Nimiq.PeerAddress[]) {
        const peerAddressStates = peerAddresses.map(peerAddress => new Nimiq.PeerAddressState(peerAddress));
        const plainAddressInfos = peerAddressStates.map(peerAddressState => new Nimiq.Client.AddressInfo(peerAddressState).toPlain());
        this.fire('peer-addresses-added', plainAddressInfos);
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

    /**
     * N E W   A P I
     */

    async sendTransaction(tx: PlainTransaction | string): Promise<PlainTransactionDetails> {
        await this._consensusEstablished;
        const txDetail = await this._client.sendTransaction(tx);
        return txDetail.toPlain();
    }

    async getTransactionsByAddress(
        address: string,
        sinceHeight?: number,
        knownDetails?: PlainTransactionDetails[],
        limit?: number
    ): Promise<PlainTransactionDetails[]> {
        await this._consensusEstablished;
        const txDetails = await this._client.getTransactionsByAddress(address, sinceHeight, knownDetails, limit);
        return txDetails.map(txd => txd.toPlain());
    }
}
