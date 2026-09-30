import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../../apps/daemon/src/index.js';

test('public sign-in completes a cross-site navigation without relaxing API origin checks', async ({ page }) => {
  const folder = await mkdtemp(join(tmpdir(), 'black-box-login-'));
  await writeFile(join(folder, 'index.html'), '<!doctype html><title>BLACK BOX browser test</title><h1>Signed in</h1>');
  const token = 'a'.repeat(48);
  const daemon = createDaemon({
    port: 0,
    databasePath: ':memory:',
    dashboardPath: folder,
    publicOrigin: 'https://blackbox.example',
    accessToken: token,
  });
  try {
    await daemon.listen();
    const port = (daemon.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    await page.setContent(`<form method="post" action="${base}/login"><input name="token" value="${token}"><button>Sign in</button></form>`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(`${base}/`);
    await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible();
    const forbidden = await page.request.get(`${base}/api/health`, {
      headers: { Origin: 'null', Authorization: `Bearer ${token}` },
    });
    expect(forbidden.status()).toBe(403);
  } finally {
    await daemon.close();
    await rm(folder, { recursive: true, force: true });
  }
});
