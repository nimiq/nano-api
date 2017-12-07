# nano-api
A high-level API to the Nimiq nano client. This is intended to be the basis for nimiq wallet applications. 

### Setup
 - Import nimiq nano client: `<script src="https://cdn.nimiq.com/core/nimiq.js"></script>`
 - Import high-level API: `<script src="nano-api.js"></script>`
 - Create an Instance `const nimiq = new NimiqNano()`

### My Address
`nimiq.address` 

### My Balance
`nimiq.balance` 

### Send Funds
- API `nimiq.sendTransaction(recipient, value, fee)` 
- Example: `nimiq.sendTransaction('NQ50 XXYT 3JT3 LGMQ B3QQ VH7E HXPY 534Q JVR8', 100000000, 1000)` 

### Events
- `nimiq.onConsensusEstablished()`
- `nimiq.onBalanceChanged(balance)`
- `nimiq.onTransactionReceived(sender, value, fee)`