// rollup.config.js
import resolve from 'rollup-plugin-node-resolve';

export default [
    {
        input: 'src/nano-network-api.js',
        output: {
            file: 'dist/nano-network-api.common.js',
            format: 'cjs'
        },
        plugins: [
            resolve()
        ]
    },
    {
        input: 'src/nano-network-api.js',
        output: {
            file: 'dist/nano-network-api.umd.js',
            format: 'umd',
            name: 'window',
            extend: true
        },
        plugins: [
            resolve()
        ]
    }
];
