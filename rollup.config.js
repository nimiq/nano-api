// rollup.config.js
import { dependencies } from './package.json';
import typescript from 'rollup-plugin-typescript2';

export default [
    {
        input: 'src/NanoApi.ts',
        plugins: [
            typescript({
                useTsconfigDeclarationDir: true,
            }),
        ],
        output: {
            file: 'dist/NanoApi.es.js',
            format: 'es'
        },
        external: Object.keys(dependencies)
    }
];
