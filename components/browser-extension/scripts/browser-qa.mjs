import { chromium } from '@playwright/test';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(__dirname, '..');
const evidenceDir = path.join(extensionDir, '.qa');
const profileDir = path.join(evidenceDir, 'chrome-profile');
const port = Number(process.env.PORT || 8097);

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
]);

async function serveStatic() {
  const server = http.createServer(async (req, res) => {
    const rawPath = new URL(req.url || '/', `http://localhost:${port}`).pathname;
    const relativePath = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
    const filePath = path.normalize(path.join(extensionDir, relativePath));

    if (!filePath.startsWith(extensionDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const body = await fs.readFile(filePath);
      res.writeHead(200, { 'Content-Type': mimeTypes.get(path.extname(filePath)) || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function extensionIdFromManifestKey() {
  const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
  const alphabet = 'abcdefghijklmnop';
  return Array.from(digest, (byte) => `${alphabet[byte >> 4]}${alphabet[byte & 15]}`).join('');
}

async function configureForAcp(page) {
  if (!process.env.ACP_BASE_URL || !process.env.ACP_TOKEN) return false;

  await page.evaluate(({ baseUrl, projectName, token }) => {
    localStorage.setItem('acpConfig', JSON.stringify({
      baseUrl,
      projectName,
      theme: 'light',
    }));
    localStorage.setItem('acpToken', JSON.stringify({
      access_token: token,
      manual: true,
      expires_at: Date.now() + 24 * 3600 * 1000,
    }));
  }, {
    baseUrl: process.env.ACP_BASE_URL,
    projectName: process.env.ACP_PROJECT || '',
    token: process.env.ACP_TOKEN,
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sessionsView:not(.hidden), #setupView:not(.hidden)', { timeout: 15000 });
  await page.waitForTimeout(1500);
  return true;
}

async function captureFirstChat(page, screenshotName) {
  const repliedCard = page.locator('.card').filter({ hasText: 'why is the sky blue' }).first();
  const chatButton = await repliedCard.count() > 0
    ? repliedCard.locator('button[data-act="chat"]').first()
    : page.locator('.card button[data-act="chat"]').first();
  if (await chatButton.count() === 0) return null;

  await chatButton.click();
  await page.waitForSelector('#chatView:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(2500);
  const lifecycleCount = await page.locator('.msg.lifecycle').count();
  if (lifecycleCount !== 0) throw new Error('Lifecycle messages are visible in the chat transcript');
  const timestampCount = await page.locator('.msgMeta time').count();
  if (timestampCount === 0) throw new Error('Visible chat messages do not include localized timestamps');
  const timestampText = await page.locator('.msgMeta time').first().innerText();
  if (!/\d{1,2}:\d{2}:\d{2}/.test(timestampText)) {
    throw new Error(`Chat timestamp does not include seconds: ${timestampText}`);
  }
  await page.evaluate(() => {
    const chatView = document.getElementById('chatView');
    chatView.scrollTop = chatView.scrollHeight;
  });
  const backVisible = await page.locator('#chatView .backButton').isVisible();
  if (!backVisible) throw new Error('Chat Back button is not visible after scrolling');
  const screenshotPath = path.join(evidenceDir, screenshotName);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return path.relative(extensionDir, screenshotPath);
}

async function verifyNotifications(page) {
  await page.evaluate(() => {
    const config = JSON.parse(localStorage.getItem('acpConfig') || '{}');
    localStorage.setItem('acpConfig', JSON.stringify({ ...config, theme: 'light' }));
    localStorage.setItem('notifications', JSON.stringify([
      {
        id: 1,
        read: false,
        ts: '2026-07-07T03:21:04.000Z',
        kind: 'run_finished',
        title: 'ACP session stopped',
        body: 'test1',
        sessionId: 'session-test1',
      },
    ]));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#notificationPanel:not(.hidden)', { timeout: 10000 });
  await page.screenshot({ path: path.join(evidenceDir, 'sidepanel-notifications-unread.png'), fullPage: true });
  await page.locator('#markReadButton').click();
  await page.waitForFunction(() => document.getElementById('notificationPanel')?.classList.contains('hidden'), null, { timeout: 10000 });
  await page.screenshot({ path: path.join(evidenceDir, 'sidepanel-notifications-read.png'), fullPage: true });
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('notifications') || '[]'));
  if (!stored.every((notification) => notification.read)) {
    throw new Error('Mark all read did not persist read notification state');
  }
  return [
    path.relative(extensionDir, path.join(evidenceDir, 'sidepanel-notifications-unread.png')),
    path.relative(extensionDir, path.join(evidenceDir, 'sidepanel-notifications-read.png')),
  ];
}

async function verifyEnterSubmitsChat(page) {
  await page.evaluate(() => {
    window.__qaSubmittedChat = false;
    const form = document.getElementById('chatForm');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.__qaSubmittedChat = true;
    }, { once: true, capture: true });
  });
  await page.locator('#chatInput').fill('keyboard submit probe');
  await page.locator('#chatInput').press('Enter');
  const submitted = await page.waitForFunction(() => window.__qaSubmittedChat === true, null, { timeout: 5000 }).then(() => true).catch(() => false);
  if (!submitted) throw new Error('Pressing Enter in chat input did not submit the chat form');
}

async function verifyPhaseActionGating(page) {
  await page.evaluate(() => {
    mergeSession({
      id: 'qa-phase-probe',
      name: 'qa phase probe',
      phase: null,
      llm_model: 'claude-sonnet-4-6',
      prompt: 'phase action gating',
      created_at: new Date().toISOString(),
    });
    renderSessions();
  });
  const probe = page.locator('.card[data-id="qa-phase-probe"]');
  await probe.locator('.badge', { hasText: 'Ready' }).waitFor({ timeout: 5000 });
  if (await probe.locator('button[data-act="start"]').count() !== 1) {
    throw new Error('Ready session did not expose Start action');
  }

  await page.evaluate(() => {
    mergeSession({ id: 'qa-phase-probe', phase: 'Creating' });
    renderSessions();
  });
  await probe.locator('.badge', { hasText: 'Creating' }).waitFor({ timeout: 5000 });
  if (await probe.locator('button[data-act="start"]').count() !== 0) {
    throw new Error('Creating session exposed Start action');
  }
}

async function sidePanelBehavior(context) {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  return worker.evaluate(() => chrome.sidePanel.getPanelBehavior());
}

async function main() {
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.rm(profileDir, { recursive: true, force: true });

  const server = await serveStatic();
  const context = await chromium.launchPersistentContext(profileDir, {
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    headless: false,
    viewport: { width: 420, height: 640 },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=460,720',
    ],
  });

  try {
    const staticPage = await context.newPage();
    await staticPage.goto(`http://127.0.0.1:${port}/index.html`);
    await staticPage.screenshot({ path: path.join(evidenceDir, 'sidepanel-static.png'), fullPage: true });
    const configuredStatic = await configureForAcp(staticPage);
    if (configuredStatic) {
      await staticPage.screenshot({ path: path.join(evidenceDir, 'sidepanel-static-sessions.png'), fullPage: true });
    }

    const extensionId = await extensionIdFromManifestKey();
    const panelBehavior = await sidePanelBehavior(context);
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });
    await extensionPage.screenshot({ path: path.join(evidenceDir, 'sidepanel-extension.png'), fullPage: true });
    const configuredExtension = await configureForAcp(extensionPage);
    if (configuredExtension) {
      await extensionPage.screenshot({ path: path.join(evidenceDir, 'sidepanel-extension-sessions.png'), fullPage: true });
    }
    const extensionChatScreenshot = configuredExtension
      ? await captureFirstChat(extensionPage, 'sidepanel-extension-chat.png')
      : null;
    if (extensionChatScreenshot) await verifyEnterSubmitsChat(extensionPage);
    if (configuredExtension) await verifyPhaseActionGating(extensionPage);
    const notificationScreenshots = configuredExtension ? await verifyNotifications(extensionPage) : [];

    const summary = {
      extensionId,
      staticUrl: `http://127.0.0.1:${port}/index.html`,
      extensionUrl: `chrome-extension://${extensionId}/index.html`,
      panelBehavior,
      screenshots: [
        path.relative(extensionDir, path.join(evidenceDir, 'sidepanel-static.png')),
        path.relative(extensionDir, path.join(evidenceDir, 'sidepanel-extension.png')),
        ...(configuredStatic ? [path.relative(extensionDir, path.join(evidenceDir, 'sidepanel-static-sessions.png'))] : []),
        ...(configuredExtension ? [path.relative(extensionDir, path.join(evidenceDir, 'sidepanel-extension-sessions.png'))] : []),
        ...(extensionChatScreenshot ? [extensionChatScreenshot] : []),
        ...notificationScreenshots,
      ],
    };
    await fs.writeFile(path.join(evidenceDir, 'browser-qa.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await context.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
