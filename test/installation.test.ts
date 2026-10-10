import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

for (const scope of ['global', 'project'] as const) {
  test(`copied ${scope} extension is auto-discovered without the extracted download`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pidude-web-inspector-install-'));
    try {
      const download = join(root, 'download');
      const staging = join(root, 'staging');
      const project = join(root, 'app');
      const agent = join(root, 'agent');
      await mkdir(download);
      await mkdir(project);
      await mkdir(agent);
      await cp(join(packageRoot, 'package.json'), join(download, 'package.json'));
      await cp(join(packageRoot, 'src'), join(download, 'src'), { recursive: true });
      await cp(join(packageRoot, 'optional'), join(download, 'optional'), { recursive: true });
      await cp(download, staging, { recursive: true });
      const destination = scope === 'global'
        ? join(agent, 'extensions', 'pidude-web-inspector')
        : join(project, '.pi', 'extensions', 'pidude-web-inspector');
      await mkdir(join(destination, '..'), { recursive: true });
      await rename(staging, destination);
      await rm(download, { recursive: true });

      // Real Pi discovery/loader; no explicit -e paths or package registration.
      const loaded = await discoverAndLoadExtensions([], project, agent);
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1); // The optional Git repair must not auto-load.
      const extension = loaded.extensions[0];
      assert.equal(extension.resolvedPath, join(destination, 'src', 'index.ts'));
      assert.ok(extension.commands.has('preview'));
      assert.ok((await readFile(join(destination, 'src', 'picker.js'), 'utf8')).includes('Pi · Preview'));
      let help = '';
      await extension.commands.get('preview')!.handler('help', {
        mode: 'tui', ui: { notify: (text: string) => { help = text; } },
      } as unknown as ExtensionCommandContext);
      assert.match(help, /Insert into Pi/);
      // Browser dependency installation/runtime is covered by the separate
      // browser suite. This test checks copy independence and Pi discovery.
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
