export default class NanoApi {

    static get API_URL() { return 'https://cdn.nimiq-network.com/branches/styppo-crypto-cleanup/nimiq.js' }
    static get satoshis() { return 100000000 }

    constructor(connect = false) {
        // console.warn('connect = false', connect = false)
        this._init(connect)
    }

    async _init(connect) {
        await NanoApi._importApi();
        this.$ = {}
        Nimiq.init($ => this._onApiReady(connect), e => this.onDifferentTabError(e));
    }

    async _onApiReady(connect) {
        await Nimiq.Crypto.prepareSyncCryptoWorker();
        this.$.walletStore = await new Nimiq.WalletStore();
        this.$.wallet = this.$.wallet || await this.$.walletStore.getDefault();
        this.onAddressChanged(this.address);
        if (connect) await this.connect();
        this.onInitialized();
    }

    async connect() {
        this.$.consensus = await Nimiq.Consensus.nano();
        this.$.consensus.on('established', e => this._onConsensusEstablished());
        this.$.consensus.network.connect();
        this.$.consensus.blockchain.on('head-changed', e => this._headChanged());
        this.$.consensus.mempool.on('transaction-added', tx => this._transactionAdded(tx));
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

    _transactionAdded(tx) {
        if (!tx.recipient.equals(this.$.wallet.address)) return;
        const sender = tx.senderPubKey.toAddress();
        this.onTransactionReceived(sender.toUserFriendlyAddress(), tx.value / NanoApi.satoshis, tx.fee);
    }

    /*
        Public API
    */
    async sendTransaction(recipient, value, fees = 0) {
        const recipientAddr = Nimiq.Address.fromUserFriendlyAddress(recipient);
        value = Math.round(Number(value) * NanoApi.satoshis);
        fees = Math.round(Number(fees) * NanoApi.satoshis);
        const tx = this.$.wallet.createTransaction(recipientAddr, value, fees, this.$.consensus.blockchain.height);
        return this.$.consensus.relayTransaction(tx);
    }

    get address() {
        return this.$.wallet.address.toUserFriendlyAddress();
    }

    get balance() {
        return (this._balance / NanoApi.satoshis) || 0;
    }

    async generateKeyPair() {
        const keys = Nimiq.KeyPair.generate();
        const privKey = keys.privateKey.toHex();
        const address = keys.publicKey.toAddress();
        return {
            privateKey: privKey,
            address: address.toUserFriendlyAddress()
        }
    }

    async importKey(privateKey, persist = true) {
        const keyPair = Nimiq.KeyPair.fromHex(privateKey);
        this.$.wallet = new Nimiq.Wallet(keyPair);
        if (persist) await this.$.walletStore.put(this.$.wallet);
        this.onAddressChanged(this.address);
    }

    exportKey() {
        return this.$.wallet.keyPair.privateKey.toHex();
    }


    lockWallet(pin) {
        return this.$.wallet.lock(pin);
    }

    unlockWallet(pin) {
        return this.$.wallet.unlock(pin);
    }

    async importEncrypted(encryptedKey, password) {
        this.$.wallet = await Nimiq.Wallet.loadEncrypted(encryptedKey, password);
        return this.$.wallet.persist();
    }


    exportEncrypted(password) {
        return '//Todo:';
        this.$.wallet.exportEncrypted(password);
    }

    onAddressChanged(address) { console.log('address changed') }

    onInitialized() { console.log('Nimiq API ready to use') }

    onConsensusEstablished() { console.log('consensus established'); }

    onBalanceChanged(balance) { console.log('new balance:', balance); }

    onTransactionReceived(sender, value, fee) { console.log('received:', value, 'from:', sender, 'txfee:', fee); }

    onDifferentTabError() { console.log('Nimiq API is already running in a different tab'); }

    static formatValue(number, decimals = 3) {
        number = Number(number)
        decimals = Math.pow(10, decimals);
        return Math.round(number * decimals) / decimals;
    }

    static formatValueInDollar(number) {
        number = Number(number)
        return this.formatValue(number * 17.1, 2);
    }

    static validateAddress(address) {
        try {
            this.isUserFriendlyAddress(address);
            return true;
        } catch (e) {
            return false;
        }
    }

    // Copied from: https://github.com/nimiq-network/core/blob/master/src/main/generic/consensus/base/account/Address.js

    static isUserFriendlyAddress(str) {
        str = str.replace(/ /g, '');
        if (str.substr(0, 2).toUpperCase() !== 'NQ') {
            throw new Error('Addresses start with NQ', 201);
        }
        if (str.length !== 36) {
            throw new Error('Addresses are 36 chars (ignoring spaces)', 202);
        }
        if (this._ibanCheck(str.substr(4) + str.substr(0, 4)) !== 1) {
            throw new Error('Address Checksum invalid', 203);
        }
    }

    static _ibanCheck(str) {
        const num = str.split('').map((c) => {
            const code = c.toUpperCase().charCodeAt(0);
            return code >= 48 && code <= 57 ? c : (code - 55).toString();
        }).join('');
        let tmp = '';

        for (let i = 0; i < Math.ceil(num.length / 6); i++) {
            tmp = (parseInt(tmp + num.substr(i * 6, 6)) % 97).toString();
        }

        return parseInt(tmp);
    }

    static _importApi() {
        return new Promise((resolve, reject) => {
            let script = document.createElement('script');
            script.type = 'text/javascript';
            script.src = NanoApi.API_URL;
            script.addEventListener('load', () => resolve(script), false);
            script.addEventListener('error', () => reject(script), false);
            document.body.appendChild(script);
        });
    }
}