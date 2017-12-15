class NanoApi {

    static get satoshis() { return 100000000 }

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
        this.onBalanceChanged(this.balance);
    }

    _getAccount() {
        return this.$.consensus.getAccount(this.$.wallet.address);
    }

    async _getBalance() {
        const account = await this._getAccount();
        return account.balance;
    }

    _onConsensusEstablished() {
        this._headChanged();
        this.onConsensusEstablished();
    }

    async _transactionAdded(tx) {
        if (!tx.recipient.equals(this.$.wallet.address)) return;
        const sender = await tx.senderPubKey.toAddress();
        this.onTransactionReceived(sender.toUserFriendlyAddress(), tx.value / NanoApi.satoshis, tx.fee);
    }

    /*
        Public API
    */
    async sendTransaction(recipient, value, fee) {
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(recipient);
        const nonce = (await this._getAccount()).nonce;
        value = Math.round(Number(value) * NanoApi.satoshis);
        fee = Number(fee);
        const tx = await this.$.wallet.createTransaction(recipientAddr, value, fee, nonce);
        return this.$.consensus.relayTransaction(tx);
    }

    get address() {
        return this.$.wallet.address.toUserFriendlyAddress();
    }

    get balance() {
        return (this._balance / NanoApi.satoshis) || 0;
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