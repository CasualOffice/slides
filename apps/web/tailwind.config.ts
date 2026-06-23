import type { Config } from 'tailwindcss';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import preset from '@univerjs-infra/shared/tailwind';
import animate from 'tailwindcss-animate';

// Tailwind only generates the engine's `univer-`-prefixed utilities (the preset
// sets prefix: 'univer-' and preflight: false, so it never touches the product's
// own hand-written CSS). Scan the univer-revamp submodule's tailwind-enabled
// packages so those utilities are emitted when consuming engine source.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(__dirname, '../../univer-revamp');

const engineContent = ['packages', 'common']
    .flatMap((group) => {
        const groupDir = path.join(engineRoot, group);
        if (!fs.existsSync(groupDir)) return [];
        return fs.readdirSync(groupDir).map((d) => path.join(groupDir, d));
    })
    .filter((dir) => fs.existsSync(path.join(dir, 'tailwind.config.ts')))
    .map((dir) => `${dir}/src/**/*.{js,ts,jsx,tsx}`);

const config: Config = {
    presets: [preset],
    content: [
        './index.html',
        './src/**/*.{js,ts,jsx,tsx}',
        ...engineContent,
    ],
    plugins: [animate],
};

export default config;
