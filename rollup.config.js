// rollup.config.js
const dependencies = Object.keys(require('./package.json').dependencies);

export default [
    {
        input: 'src/nano-network-api.js',
        output: {
            file: 'dist/nano-network-api.common.js',
            format: 'cjs'
        },
        external: dependencies
    },
    {
        input: 'src/nano-network-api.js',
        output: {
            file: 'dist/nano-network-api.umd.js',
            format: 'umd',
            name: 'window',
            extend: true,
            globals: {
                '@nimiq/utils': 'window'
            }
        },
        external: dependencies
    },
    {
        input: 'src/nano-network-api.js',
        output: {
            file: 'dist/nano-network-api.es.js',
            format: 'es'
        },
        external: dependencies
    }
];
