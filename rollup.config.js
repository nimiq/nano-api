// rollup.config.js
const dependencies = Object.keys(require('./package.json').dependencies);

export default [
    {
        input: 'build/NanoApi.js',
        output: {
            file: 'dist/NanoApi.common.js',
            format: 'cjs'
        },
        external: dependencies
    },
    {
        input: 'build/NanoApi.js',
        output: {
            file: 'dist/NanoApi.umd.js',
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
        input: 'build/NanoApi.js',
        output: {
            file: 'dist/NanoApi.es.js',
            format: 'es'
        },
        external: dependencies
    }
];
