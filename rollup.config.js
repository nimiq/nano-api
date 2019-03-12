// rollup.config.js
const dependencies = Object.keys(require('./package.json').dependencies);

export default [
    {
        input: 'build/nano-api.js',
        output: {
            file: 'dist/nano-api.common.js',
            format: 'cjs'
        },
        external: dependencies
    },
    {
        input: 'build/nano-api.js',
        output: {
            file: 'dist/nano-api.umd.js',
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
        input: 'build/nano-api.js',
        output: {
            file: 'dist/nano-network-api.es.js',
            format: 'es'
        },
        external: dependencies
    }
];
