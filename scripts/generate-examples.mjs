import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

// Load the exact application modules, without opening an HTTP server.
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
try {
  const { scenarios } = await server.ssrLoadModule('/src/scenarios/index.ts');
  const { serializeTrace } = await server.ssrLoadModule('/src/core/serialization.ts');
  const { exportSnapshotSvg, exportPlayerSvg } = await server.ssrLoadModule('/src/core/export.ts');
  const directory = resolve('docs/examples');
  await mkdir(directory, { recursive: true });
  for (const scenario of scenarios) {
    const trace = scenario.build();
    await writeFile(resolve(directory, `${trace.id}.trace.json`), `${serializeTrace(trace)}\n`);
    await writeFile(resolve(directory, `${trace.id}.svg`), cleanSvg(exportSnapshotSvg(trace, trace.events.length - 1)));
    if (scenario.id === 'latest-wins') {
      await writeFile(resolve(directory, `${trace.id}-player.svg`), cleanSvg(exportPlayerSvg(trace)));
    }
    console.log(`${trace.id}: ${trace.events.length} events, ${trace.events.at(-1)?.time ?? 0} ${trace.clock.unit}`);
  }
} finally {
  await server.close();
}

function cleanSvg(source) {
  return `${source.replace(/[ \t]+$/gm, '').trimEnd()}\n`;
}
