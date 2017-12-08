class NanoApi {
    constructor() {
        Nimiq.init(() => this.init(), console.error);
    }

    async init() {
        const $ = {};
        $.consensus = await Nimiq.Consensus.nano();
        $.wallet = await Nimiq.Wallet.getPersistent();
        $.consensus.on('established', e => this._onConsensusEstablished());
        $.consensus.network.connect();
        $.consensus.blockchain.on('head-changed', e => this._headChanged());
        $.consensus.mempool.on('transaction-added', tx => this._transactionAdded(tx));
        this.$ = $;
        this.onInitialized();
    }

    async _headChanged() {
        if (!this.$.consensus.established) return;
        const balance = await this._getBalance();
        if (this._balance === balance) return;
        this._balance = balance;
        this.onBalanceChanged(balance);
    }

    async _getAccount() {
        const account = await this.$.consensus.getAccount(this.$.wallet.address);
        return account.balance;
    }

    async _getBalance() {
        const account = await this._getAccount();
        return account.value;
    }

    _onConsensusEstablished() {
        this._headChanged();
        this.onConsensusEstablished();
    }

    async _transactionAdded(tx) {
        if (!tx.recipientAddr.equals(this.$.wallet.address)) return;
        const senderAddr = await tx.senderPubKey.toAddress();
        this.onTransactionReceived(senderAddr.toUserFriendlyAddress(), tx.value, tx.fee);
    }

    /*
        Public API
    */
    async sendTransaction(recipient, value, fee) {
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(recipient);
        const nonce = (await this._getAccount()).nonce;
        value = Math.round(Number(value) * 100000000);
        fee = Number(fee);
        const tx = await this.$.wallet.createTransaction(recipientAddr, value, fee, nonce);
        return this.$.consensus.relayTransaction(tx);
    }

    get address() {
        return this.$.wallet.address.toUserFriendlyAddress();
    }

    get balance() {
        return this._balance || 0;
    }

    onInitialized() {
        console.log('Nimiq API ready to use')
    }

    onConsensusEstablished() {
        console.log('consensus established');
    }

    onBalanceChanged(balance) {
        console.log('new balance:', balance);
    }

    onTransactionReceived(sender, value, fee) {
        console.log('received:', value, 'from:', sender, 'txfee:', fee);
    }
}