// Entry point for the markdown-render-speed-02 submission.
// For every case in /input/cases.json it renders the markdown on its own
// with the dependency-free parse() from parse.js and collects the HTML
// strings in order into /output/html.json. Each case is parsed from
// scratch — nothing is cached or shared between cases, exactly as the
// harness expects. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type InputCase = { id: string; markdown: string };

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(
  readFileSync(join(inDir, 'cases.json'), 'utf8'),
) as InputCase[];

const rendered: string[] = [];
for (const c of cases) {
  rendered.push(parse(c.markdown));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(rendered));
