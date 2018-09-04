# Nano Api
A high-level API to the Nimiq nano client. This is intended to be the basis for nimiq wallet applications. 

## Setup
```
npm install @nimiq/nano-api
```
or
```
yarn add @nimiq/nano-api
```

Create an Instance:
```javascript
const config = {
	cdn: 'https://cdn.nimiq.com/nimiq.js',
	network: 'test' // or 'main'
}
const nimiq = new NanoApi(config)

```
