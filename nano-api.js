class NanoApi {

    static get satoshis() { return 100000000 }

    constructor() {
        this.$ = {}
        Nimiq.init(() => this.init(), console.error);
    }

    async init() {
        this.$.wallet = this.$wallet || await Nimiq.Wallet.getPersistent();
        this.onAddressChanged(this.address);
        this.$.consensus = await Nimiq.Consensus.nano();
        this.$.consensus.on('established', e => this._onConsensusEstablished());
        this.$.consensus.network.connect();
        this.$.consensus.blockchain.on('head-changed', e => this._headChanged());
        this.$.consensus.mempool.on('transaction-added', tx => this._transactionAdded(tx));
        this.onInitialized();
    }

    async _headChanged() {
        if (!this.$.consensus.established) return;
        const balance = await this._getBalance();
        if (this._balance === balance) return;
        this._balance = balance;
        this.onBalanceChanged(this.balance);
    }

    async _getAccount() {
        const account = await this.$.consensus.getAccount(this.$.wallet.address);
        return account || { balance: 0, nonce: 0 }
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
    async sendTransaction(recipient, value, fees = 0) {
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(recipient);
        const nonce = (await this._getAccount()).nonce;
        value = Math.round(Number(value) * NanoApi.satoshis);
        fees = Math.round(Number(fees) * NanoApi.satoshis);
        const tx = await this.$.wallet.createTransaction(recipientAddr, value, fees, nonce);
        return this.$.consensus.relayTransaction(tx);
    }

    get address() {
        return this.$.wallet.address.toUserFriendlyAddress();
    }

    get balance() {
        return (this._balance / NanoApi.satoshis) || 0;
    }

    static validateAddress(address) {
        try {
            Nimiq.Address.fromUserFriendlyAddress(address);
            return true;
        } catch (e) {
            return false;
        }
    }

    async generateKeyPair() {
        const keys = await Nimiq.KeyPair.generate();
        const privKey = keys.privateKey.toHex();
        const address = await keys.publicKey.toAddress();
        return {
            privateKey: privKey,
            address: address.toUserFriendlyAddress()
        }
    }

    async importKey(privateKey) {
        privateKey = new Nimiq.PrivateKey(Nimiq.BufferUtils.fromHex(privateKey));
        const keyPair = await Nimiq.KeyPair.derive(privateKey);
        this.$.wallet = new Nimiq.Wallet(keyPair);
        await this.$.wallet.persist();
        if (!this.$.consensus) return;
        this._onConsensusEstablished();
    }

    exportKey() {
        return nimiq.$.wallet.keyPair.privateKey.toHex();
    }

    onAddressChanged(address) {
        console.log('address changed')
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

    lockWallet(pin) {
        //TODO
        return Promise.resolve()
    }

    unlockWallet(pin) {
        return new Promise((resolve, error) => {
            // Dummy implementation
            setTimeout(() => pin === '111111' ? resolve() : error(), 2000);
        })
    }

    importWallet(encryptedKey, pin) {
        //TODO
        return Promise.resolve()
    }

    exportWallet(pin) {
        // unlock wallet
        return Promise.resolve('<<encrypted key>>')
    }
}