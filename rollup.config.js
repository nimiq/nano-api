// rollup.config.js
const dependencies = Object.keys(require('./package.json').dependencies);

export default [
    {
        input: 'build/nano-network-api.js',
        output: {
            file: 'dist/nano-network-api.common.js',
            format: 'cjs'
        },
        external: dependencies
    },
    {
        input: 'build/nano-network-api.ts',
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
        input: 'build/nano-network-api.ts',
        output: {
            file: 'dist/nano-network-api.es.js',
            format: 'es'
        },
        external: dependencies
    }
];
