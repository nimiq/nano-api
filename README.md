# nano-api
A high-level API to the Nimiq nano client. This is intended to be the basis for nimiq wallet applications. 

### Setup
 - Import nimiq nano client: `<script src="https://cdn.nimiq.com/core/nimiq.js"></script>`
 - Import high-level API: `<script src="nano-api.js"></script>`
 - Create an Instance `const nimiq = new NanoApi()`

### My Address
`nimiq.address` 

### My Balance
`nimiq.balance` 

### Send Funds
- API `nimiq.sendTransaction(recipient, value, fee)` (`value` and `fee` in `NIM`)
- Example: `nimiq.sendTransaction('NQ50 XXYT 3JT3 LGMQ B3QQ VH7E HXPY 534Q JVR8', 10.2, 0.001)` 

### Events
- `nimiq.onConsensusEstablished()`
- `nimiq.onBalanceChanged(balance)`
- `nimiq.onTransactionReceived(sender, value, fee)`

Example event handler implementation:
```
class MyNimiqApi extends NanoApi{
	
	onInitialized() {
        console.log('Nimiq API ready to use')
    }

	onConsensusEstablished(){
		console.log('consensus established')
	}

	onBalanceChanged(balance){
		console.log('my new balance:', balance)
	}

	onTransactionReceived(sender, value, fee){
		console.log('transaction received from',sender, 'tx-value:',value,'fees payed',fee)
	}
} 
const nimiq = new MyNimiqApi();
```  