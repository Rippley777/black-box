import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

test.describe.configure({ mode: 'serial' });

test('empty recorder, real log upload, live filtering, reconstruction and incident resolution', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('AWAITING FIRST SIGNAL')).toBeVisible();
  await expect(page.getByText('RECORDING', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/empty-recorder.png', fullPage: true });

  await page.getByRole('button', { name: 'Attach logs', exact: true }).first().click();
  await page.getByLabel('Source application').fill('browser-import');
  await page
    .getByLabel('Log content')
    .fill(
      'Log imported through the workbench\n{"level":"error","message":"API failure","password":"browser-secret"}',
    );
  await page.getByRole('button', { name: 'Record logs', exact: true }).click();
  await expect(page.getByText('Log imported through the workbench', { exact: true })).toBeVisible();

  const registered = await request.post('/api/projects', {
    data: {
      id: 'save-scum',
      name: 'Save Scum',
      paths: ['/Code/save-scum'],
      repo: 'Rippley777/save-scum',
    },
  });
  expect(registered.ok()).toBeTruthy();
  const correlationId = randomUUID();
  const now = Date.now();
  const rows = [
    ['pit-boss', 'command.started', 'info', 'npm run dev started', { command: 'npm run dev' }],
    [
      'port-authority',
      'port.opened',
      'success',
      'Development server listening on port 5173',
      { port: 5173, pid: 19421 },
    ],
    [
      'env-reaper',
      'environment.missing_variable',
      'warning',
      'Missing environment variable API_URL',
      { variable: 'API_URL' },
    ],
    [
      'save-scum',
      'http.error',
      'error',
      'OAuth request returned HTTP 500',
      { status: 500, port: 5173, authorization: 'Bearer browser-private' },
    ],
    [
      'port-authority',
      'process.exited',
      'error',
      'Node process exited with status 1',
      { pid: 19421, exitCode: 1 },
    ],
  ];
  const ingested = await request.post('/api/events', {
    data: rows.map(([app, type, severity, message, data], index) => ({
      id: randomUUID(),
      timestamp: new Date(now + index - 5000).toISOString(),
      source: { app, version: '1.0.0' },
      project: { id: 'save-scum' },
      correlationId,
      type,
      severity,
      message,
      data,
      tags: ['dev'],
    })),
  });
  expect(ingested.ok()).toBeTruthy();
  await expect(page.getByText('Node process exited with status 1', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/timeline-desktop.png', fullPage: true });
  await page.getByLabel('Search events').fill('project:save-scum severity:error');
  await expect(page.locator('.event-row')).toHaveCount(2);
  await page.getByText('Node process exited with status 1', { exact: true }).click();
  await page.getByRole('button', { name: 'What the hell happened?' }).click();
  const context = page.getByRole('dialog', { name: 'What the hell happened?' });
  await expect(
    context.getByText('Missing environment variable API_URL', { exact: true }),
  ).toBeVisible();
  await expect(context.getByText('npm run dev started', { exact: true })).toBeVisible();
  await context.getByRole('button', { name: /Save as incident|Create incident/ }).click();
  await page.getByRole('button', { name: 'Resolve incident', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reopen incident' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  const exported = await request.get('/api/export');
  const text = await exported.text();
  expect(text).not.toContain('browser-private');
  expect(text).not.toContain('browser-secret');
  expect(text).toContain('[REDACTED]');
  expect(errors).toEqual([]);
});

test('project registration, application registry, keyboard navigation and persisted retention', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Register project', exact: true }).click();
  await page.getByLabel('Display name').fill('Deck');
  await page.getByLabel('Local path').fill('/Code/deck');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Register project', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Deck', exact: true })).toBeVisible();
  expect((await (await request.get('/api/projects/deck')).json()).project.paths).toContain(
    '/Code/deck',
  );
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search commands').fill('Connected applications');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
  await expect(page.getByText('port-authority', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('debug retention').selectOption('30');
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByText('Retention policy saved', { exact: true })).toBeVisible();
  expect((await (await request.get('/api/settings')).json()).retention.debug).toBe(30);
});

test('mobile timeline stays usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Event timeline/ })).toBeVisible();
  await expect(page.getByLabel('Search events')).toBeVisible();
  await page.getByLabel('Search events').fill('port:5173');
  await expect(page.locator('.event-row')).toHaveCount(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: 'artifacts/timeline-mobile.png', fullPage: true });
});

test('suggested action waits for confirmation and shows the provider result', async ({
  page,
  request,
}) => {
  await request.post('/api/applications', {
    data: {
      id: 'browser-provider',
      name: 'Browser test provider',
      capabilities: [{ name: 'project.restart', requiresConfirmation: true }],
    },
  });
  const socket = new WebSocket('ws://127.0.0.1:47921/stream?appId=browser-provider');
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const commands: string[] = [];
  socket.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.kind !== 'command') return;
    commands.push(message.command.id);
    void (async () => {
      await request.post(`/api/commands/${message.command.id}/ack`, {
        data: { appId: 'browser-provider', status: 'accepted' },
      });
      await request.post(`/api/commands/${message.command.id}/ack`, {
        data: { appId: 'browser-provider', status: 'completed', result: { restarted: true } },
      });
    })();
  });
  try {
    await request.post('/api/events', {
      data: {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        source: { app: 'browser-provider' },
        type: 'process.failed',
        severity: 'error',
        message: 'Action test process needs attention',
        actions: [
          {
            id: 'restart-test',
            label: 'Restart sandbox',
            provider: 'browser-provider',
            command: 'project.restart',
            payload: { projectId: 'save-scum' },
            requiresConfirmation: true,
          },
        ],
      },
    });
    await page.goto('/');
    await page.getByText('Action test process needs attention', { exact: true }).click();
    await page.getByRole('button', { name: /Restart sandbox/ }).click();
    const modal = page.getByRole('dialog', { name: 'Restart sandbox' });
    await expect(modal).toBeVisible();
    expect(commands).toHaveLength(0);
    await modal.getByRole('button', { name: 'Confirm and run' }).click();
    await expect(page.locator('.command-status')).toContainText('completed');
    await expect(page.locator('.command-status')).toContainText('"restarted": true');
    expect(commands).toHaveLength(1);
  } finally {
    socket.terminate();
  }
});
