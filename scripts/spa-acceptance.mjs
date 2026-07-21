import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium as defaultChromium } from 'playwright';

import { DEVELOPMENT_BOUNDARY, loadOperatorConfiguration } from './development-operator.mjs';

const CERTAUTH_ORIGIN = 'https://certauth.login.microsoftonline.com';
const AFTER_PARTY_CLIENT_ID = '9edaa951-658e-4be2-9623-ee906cb604b2';
const ALLOWED_LOGIN_HOSTS = new Set(['login.microsoftonline.com', 'certauth.login.microsoftonline.com']);
const REVIEWED_RESOURCE_ACCESS = Object.freeze({
  '00000003-0000-0000-c000-000000000000': Object.freeze([
    'e1fe6dd8-ba31-4d61-89e7-88639da4683d', 'c5366453-9fb0-48a5-a156-24f0c49a4b84',
    'bdfbf15f-ee85-4955-8675-146e8e5296b5', '84bccea3-f856-4a8a-967b-dbe0a3d53a64',
    '4e46008b-f24c-477d-8fff-7bb4ec7aafe0', '204e0828-b5ca-4ad8-b9f3-f32a958e7cc4',
    'd01b97e9-cbc0-49fe-810a-750afd5527a3', 'ad902697-1014-4ef5-81ef-2b4301988e8c',
    'e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20', '02e97553-ed7b-43d0-ab3c-f8bace0d040c',
    '024d486e-b451-40bb-833d-3e66d98c5c73', 'e383f46e-2787-4529-855e-0e479a3ffac0',
    '863451e7-0667-486c-a5d6-d135439485f0', '89fe6a52-be36-487e-b7d8-d061c450a026',
    '6aedf524-7e1c-45a7-bd76-ded8cab8d0fc',
  ]),
  '797f4846-ba00-4fd7-ba43-dac1f8f63013': Object.freeze(['41094075-9dad-400e-a0bd-54e686782033']),
});
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  /\b(?:code|client_info|id_token|access_token|refresh_token|session_state)=([^\s&]+)/gi,
  /["']?(?:code|client_info|id_token|access_token|refresh_token|session_state)["']?\s*:\s*["'][^"']+["']/gi,
];

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

export function redactText(value, limit = 3000) {
  let text = String(value || '');
  for (const [index, pattern] of SECRET_PATTERNS.entries()) {
    text = text.replace(pattern, (match) => [1, 3].includes(index) ? '[redacted-secret]' : `${match.split(/[=\s]/)[0]}=[redacted]`);
  }
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, limit);
}

export function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

async function visibleText(page) {
  return redactText(await page.locator('body').innerText().catch(() => ''), 3000);
}

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

async function clickFirst(locators) {
  for (const locator of locators) {
    if (await visible(locator)) {
      await locator.click();
      return true;
    }
  }
  return false;
}

function aadstsError(text) {
  return text.match(/AADSTS\d{5,}[^\r\n]*/i)?.[0] || null;
}

export async function driveMicrosoftRedirect({
  page,
  spaOrigin,
  userPrincipalName,
  expectedClientId = AFTER_PARTY_CLIENT_ID,
  expectedTenantId = DEVELOPMENT_BOUNDARY.tenantId,
  allowConsent = false,
  signal,
  timeoutMs = 120_000,
  checkpoint = () => {},
}) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';
  let stagnant = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const current = page.url();
    try {
      const microsoftUrl = new URL(current);
      if (microsoftUrl.origin !== spaOrigin && !ALLOWED_LOGIN_HOSTS.has(microsoftUrl.hostname)) {
        throw new Error('Microsoft sign-in navigated to an unapproved origin.');
      }
      if (microsoftUrl.hostname === 'login.microsoftonline.com' && /\/(?:oauth2\/|adminconsent)/i.test(microsoftUrl.pathname)) {
        const clientId = microsoftUrl.searchParams.get('client_id');
        if (!clientId || clientId.toLowerCase() !== expectedClientId.toLowerCase()) {
          throw new Error('Microsoft authorization targeted an unexpected application.');
        }
        if (/\/adminconsent/i.test(microsoftUrl.pathname) && !microsoftUrl.pathname.toLowerCase().includes(`/${expectedTenantId.toLowerCase()}/`)) {
          throw new Error('Microsoft consent targeted an unexpected tenant.');
        }
      }
    } catch (error) {
      if (/unapproved origin|unexpected application|unexpected tenant/.test(error.message)) throw error;
    }
    let origin;
    try { origin = new URL(current).origin; } catch { origin = ''; }
    if (origin === spaOrigin && await page.locator('#auth-status').count()) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }
    const text = await visibleText(page);
    const aadsts = aadstsError(text);
    if (aadsts) throw new Error(aadsts);
    if (/conditional access|you cannot access this right now|sign-in was blocked/i.test(text)) {
      throw new Error(`Microsoft Conditional Access blocked the dedicated operator: ${text}`);
    }
    const password = page.locator('input[name="passwd"]:visible');
    if (await visible(password)) throw new Error('Microsoft requested a password instead of the configured operator certificate.');

    const account = page.getByText(userPrincipalName, { exact: true }).first();
    if (await visible(account) && /pick an account|choose an account|sign in/i.test(text)) {
      await account.click();
      checkpoint('microsoft-account', 'selected-dedicated-operator');
      await wait(500);
      continue;
    }
    const username = page.locator('input[name="loginfmt"]:visible');
    if (await visible(username)) {
      await username.fill(userPrincipalName);
      await page.locator('#idSIButton9, button[type="submit"]').first().click();
      checkpoint('microsoft-username', 'submitted-dedicated-operator');
      await wait(600);
      continue;
    }
    if (await clickFirst([
      page.getByText(/use (?:a )?certificate or smart card|sign in with (?:a )?certificate|certificate-based authentication/i).first(),
      page.locator('[data-value="Certificate"], [data-value="X509Certificate"]').first(),
    ])) {
      checkpoint('microsoft-cba', 'certificate-selected');
      await wait(900);
      continue;
    }
    if (await clickFirst([
      page.getByText(/sign-in options|sign in another way/i).first(),
      page.locator('#signInAnotherWay').first(),
    ])) {
      checkpoint('microsoft-cba', 'sign-in-options-opened');
      await wait(500);
      continue;
    }
    if (/stay signed in/i.test(text) && await clickFirst([
      page.locator('#idBtn_Back').first(),
      page.getByRole('button', { name: /^No$/i }).first(),
    ])) {
      checkpoint('microsoft-session', 'persistent-session-declined');
      await wait(500);
      continue;
    }
    if (/permissions requested|review permissions|accept permissions|requested permissions/i.test(text)) {
      if (!/after party/i.test(text)) throw new Error('Microsoft displayed consent for an unexpected application.');
      if (!allowConsent) throw new Error('Microsoft requested unplanned interactive consent.');
      if (await clickFirst([
        page.locator('#idSIButton9').first(),
        page.getByRole('button', { name: /^(Accept|Continue)$/i }).first(),
      ])) {
        checkpoint('microsoft-consent', 'accepted-for-after-party');
        await wait(700);
        continue;
      }
    }
    if (/use another account/i.test(text) && await clickFirst([
      page.getByText(/use another account/i).first(),
      page.locator('#otherTile').first(),
    ])) {
      checkpoint('microsoft-account', 'requested-explicit-operator');
      await wait(500);
      continue;
    }
    if (current === lastUrl) stagnant += 1;
    else { lastUrl = current; stagnant = 0; }
    if (stagnant > 20) throw new Error(`Microsoft sign-in stopped at an unrecognized page: ${text}`);
    await wait(400);
  }
  throw new Error('Microsoft sign-in did not return to the SPA before the bounded timeout.');
}

export async function verifyReviewedConsentApplication(graph) {
  if (!graph?.request) throw new Error('Development Graph administrator is required to guard consent.');
  const filter = encodeURIComponent(`appId eq '${AFTER_PARTY_CLIENT_ID}'`);
  const page = await graph.request(`/v1.0/applications?$filter=${filter}&$select=id,appId,displayName,signInAudience,requiredResourceAccess`);
  if (page.value?.length !== 1) throw new Error('Reviewed After Party application registration is missing or duplicated.');
  const application = page.value[0];
  if (application.appId !== AFTER_PARTY_CLIENT_ID || application.displayName !== 'After Party' || application.signInAudience !== 'AzureADMultipleOrgs') {
    throw new Error('After Party application identity drifted before consent.');
  }
  const resources = application.requiredResourceAccess || [];
  if (new Set(resources.map((resource) => String(resource.resourceAppId).toLowerCase())).size !== resources.length) throw new Error('After Party application contains duplicate permission resources.');
  const actual = Object.fromEntries(resources.map((resource) => [
    String(resource.resourceAppId).toLowerCase(),
    [...(resource.resourceAccess || [])].map((entry) => {
      if (entry.type !== 'Scope') throw new Error('After Party application contains an unreviewed application permission.');
      return String(entry.id).toLowerCase();
    }).sort(),
  ]).sort(([left], [right]) => left.localeCompare(right)));
  const expected = Object.fromEntries(Object.entries(REVIEWED_RESOURCE_ACCESS).map(([appId, ids]) => [appId, [...ids].sort()]).sort(([left], [right]) => left.localeCompare(right)));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('After Party delegated permission registration drifted before consent.');
  return true;
}

async function capture(page, artifactDirectory, name) {
  const screenshotPath = resolve(artifactDirectory, `${name}.png`);
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    mask: [
      page.locator('input[type="text"]:visible, input[type="password"]:visible, textarea:visible'),
      page.locator('#account-username'),
    ],
    maskColor: '#202020',
  }).catch(() => {});
  await chmod(screenshotPath, 0o600).catch(() => {});
  return screenshotPath;
}

async function pageDiagnostic(page, stage, consoleErrors, networkErrors) {
  return Object.freeze({
    stage,
    capturedUtc: new Date().toISOString(),
    url: diagnosticUrl(page.url()),
    title: redactText(await page.title().catch(() => ''), 200),
    text: await visibleText(page),
    controls: (await page.locator('button:visible, input[type="submit"]:visible, select:visible').evaluateAll((elements) => elements.map((element) => ({
      label: (element.getAttribute('aria-label') || element.value || element.innerText || '').trim(),
      disabled: Boolean(element.disabled),
    }))).catch(() => [])).map((control) => ({ ...control, label: redactText(control.label, 300) })),
    consoleErrors: consoleErrors.slice(-20),
    networkErrors: networkErrors.slice(-30),
  });
}

async function finishTenantConnection({ page, spaOrigin, config, signal, checkpoint, consentGuard }) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    signal?.throwIfAborted();
    const connected = await page.locator('#installation-status').textContent().catch(() => '');
    if (/lab permissions were verified/i.test(connected)) return connected;
    const approve = page.locator('#approve-permissions');
    const verify = page.locator('#continue-verification');
    if (await visible(approve) && !(await approve.isDisabled())) {
      if (typeof consentGuard !== 'function') throw new Error('Permission approval requires an exact application-registration guard.');
      await consentGuard();
      await approve.click();
      checkpoint('tenant-connection', 'permission-approval-started');
      await page.waitForURL((url) => url.origin !== spaOrigin, { timeout: 30_000 });
      await driveMicrosoftRedirect({ page, spaOrigin, userPrincipalName: config.userPrincipalName, signal, checkpoint, allowConsent: true });
      await page.waitForLoadState('networkidle').catch(() => {});
      continue;
    }
    if (await visible(verify) && !(await verify.isDisabled())) {
      await verify.click();
      checkpoint('tenant-connection', 'interactive-verification-started');
      await page.waitForURL((url) => url.origin !== spaOrigin, { timeout: 30_000 });
      await driveMicrosoftRedirect({ page, spaOrigin, userPrincipalName: config.userPrincipalName, signal, checkpoint });
      await page.waitForLoadState('networkidle').catch(() => {});
      continue;
    }
    await wait(1000);
  }
  throw new Error(`Tenant permission verification did not complete: ${await page.locator('#installation-status').textContent().catch(() => '')}`);
}

function card(page, id) {
  return page.locator(`[data-experiment-id="${id}"]`);
}

async function runCard(page, id, expectedSummary, timeoutMs, checkpoint) {
  const target = card(page, id);
  const action = target.locator('.experiment-action');
  if (await action.isDisabled()) {
    throw new Error(`${id} is disabled: ${await target.locator('.experiment-status-message').textContent()}`);
  }
  await action.click();
  checkpoint(id, 'started');
  await target.waitFor({ state: 'visible' });
  await page.waitForFunction((experimentId) => {
    const element = document.querySelector(`[data-experiment-id="${experimentId}"]`);
    return ['success', 'failure'].includes(element?.dataset.state || '');
  }, id, { timeout: timeoutMs });
  const state = await target.getAttribute('data-state');
  const message = await target.locator('.experiment-status-message').textContent();
  if (state !== 'success' || !expectedSummary.test(message || '')) {
    throw new Error(`${id} failed: ${message}`);
  }
  checkpoint(id, 'succeeded');
  return Object.freeze({
    state,
    message: redactText(message, 800),
    metadata: Object.fromEntries(Object.entries(await target.locator('.experiment-result').evaluate((element) => {
      const result = {};
      const terms = [...element.querySelectorAll('dt')];
      for (const term of terms) result[term.textContent.trim()] = term.nextElementSibling?.textContent.trim() || '';
      return result;
    })).map(([key, value]) => [redactText(key, 200), redactText(value, 1000)])),
  });
}

export async function readPublishedVersion(spaUrl, fetchImpl = fetch) {
  const url = new URL('version.json', spaUrl);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`SPA version metadata returned HTTP ${response.status}.`);
  const version = await response.json();
  if (!/^[0-9a-f]{40}$/.test(version.commit || '')) throw new Error('SPA version commit is invalid.');
  if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(version.runtimeImage || '')) throw new Error('SPA runtime image is not digest-pinned.');
  return Object.freeze(version);
}

export async function runSpaAcceptance({
  spaUrl = 'https://seanewest.github.io/after-party-labs/',
  mode = 'prove',
  expectedCommit,
  expectedRuntimeImage,
  operatorConfigPath,
  repositoryRoot = process.cwd(),
  artifactRoot = resolve(repositoryRoot, '.artifacts', 'goal-20'),
  signal,
  chromium = defaultChromium,
  fetchImpl = fetch,
  checkpoint = (stage, status) => console.log(`[${stage}] ${status}`),
  consentGuard,
} = {}) {
  if (!['authenticate', 'prove'].includes(mode)) throw new Error('SPA acceptance mode must be authenticate or prove.');
  const operator = await loadOperatorConfiguration({ configPath: operatorConfigPath, repositoryRoot });
  const version = await readPublishedVersion(spaUrl, fetchImpl);
  if (expectedCommit && version.commit !== expectedCommit) throw new Error(`Published SPA commit ${version.commit} does not match ${expectedCommit}.`);
  if (expectedRuntimeImage && version.runtimeImage !== expectedRuntimeImage) throw new Error('Published SPA runtime image does not match the expected immutable digest.');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDirectory = resolve(artifactRoot, runId);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await chmod(artifactDirectory, 0o700);
  const passphrase = (await readFile(operator.config.operatorPfxPassphrasePath, 'utf8')).trim();
  if (!passphrase) throw new Error('Operator PFX passphrase is empty.');
  const spaOrigin = new URL(spaUrl).origin;
  const consoleErrors = [];
  const networkErrors = [];
  let browser;
  let context;
  let page;
  const evidence = {
    status: 'running',
    mode,
    startedUtc: new Date().toISOString(),
    spa: { url: diagnosticUrl(spaUrl), commit: version.commit, runtimeImage: version.runtimeImage },
    boundary: DEVELOPMENT_BOUNDARY,
    operator: {
      displayName: operator.config.displayName,
      certificateFingerprint256: operator.certificate.fingerprint256,
      certificateValidTo: new Date(operator.certificate.validTo).toISOString(),
    },
  };
  try {
    signal?.throwIfAborted();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      clientCertificates: [{ origin: CERTAUTH_ORIGIN, pfxPath: operator.config.operatorPfxPath, passphrase }],
    });
    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(redactText(message.text(), 600));
    });
    page.on('response', (response) => {
      if (response.status() >= 400) networkErrors.push({ method: response.request().method(), url: diagnosticUrl(response.url()), status: response.status() });
    });
    page.on('requestfailed', (request) => networkErrors.push({ method: request.method(), url: diagnosticUrl(request.url()), failure: redactText(request.failure()?.errorText, 200) }));
    const abort = () => context?.close().catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });
    await page.goto(spaUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.locator('#connect-tenant').waitFor({ state: 'visible' });
    await page.locator('#connect-tenant').click();
    checkpoint('spa-authentication', 'redirect-started');
    await page.waitForURL((url) => url.origin !== spaOrigin, { timeout: 30_000 });
    await driveMicrosoftRedirect({ page, spaOrigin, userPrincipalName: operator.config.userPrincipalName, signal, checkpoint });
    await page.locator('#account-username').waitFor({ state: 'visible', timeout: 45_000 });
    const account = (await page.locator('#account-username').textContent() || '').trim().toLowerCase();
    const tenant = (await page.locator('#tenant-id').textContent() || '').trim().toLowerCase();
    if (account !== operator.config.userPrincipalName.toLowerCase() || tenant !== operator.config.tenantId.toLowerCase()) {
      throw new Error('The SPA returned a different operator or tenant.');
    }
    await finishTenantConnection({ page, spaOrigin, config: operator.config, signal, checkpoint, consentGuard });
    checkpoint('spa-authentication', 'dedicated-operator-and-permissions-verified');
    evidence.authentication = { status: 'verified', tenantId: tenant, method: 'authorization-code-pkce-with-cba' };
    evidence.screenshots = { authentication: await capture(page, artifactDirectory, 'authenticated') };

    if (mode === 'prove') {
      const subscription = page.locator('#runtime-subscription');
      const location = page.locator('#runtime-location');
      await subscription.waitFor({ state: 'visible', timeout: 90_000 });
      await page.waitForFunction(() => document.querySelector('#runtime-subscription')?.options.length > 0, null, { timeout: 90_000 });
      await subscription.selectOption(operator.config.subscriptionId);
      await page.waitForFunction(() => document.querySelector('#runtime-location')?.options.length > 0, null, { timeout: 90_000 });
      await location.selectOption(operator.config.region);
      await page.locator('#verify-runtime-selection:not([disabled])').waitFor({ state: 'visible', timeout: 90_000 });
      await page.locator('#verify-runtime-selection').click();
      await page.locator('#runtime-selection-status[data-kind="success"]').waitFor({ state: 'visible', timeout: 120_000 });
      const summary = await page.locator('#runtime-selection-summary').innerText();
      for (const expected of [operator.config.subscriptionId, operator.config.tenantId, operator.config.region, version.commit, version.runtimeImage, 'Owner']) {
        if (!summary.includes(expected)) throw new Error(`Verified target summary omitted expected value: ${expected}`);
      }
      await page.locator('#confirm-runtime-selection').check();
      evidence.target = { status: 'verified', tenantId: operator.config.tenantId, subscriptionId: operator.config.subscriptionId, region: operator.config.region, commit: version.commit, runtimeImage: version.runtimeImage };
      const installation = await runCard(page, 'install-tenant-runtime', /installed and verified/i, 30 * 60_000, checkpoint);
      evidence.installation = installation;
      evidence.screenshots.installation = await capture(page, artifactDirectory, 'runtime-installed');
      const lock = await runCard(page, 'test-tenant-lock', /admitted one operation.*blocked its competitor.*recovered/i, 5 * 60_000, checkpoint);
      evidence.lock = lock;
      evidence.screenshots.lock = await capture(page, artifactDirectory, 'tenant-lock-proven');
      evidence.repeat = {
        installation: await runCard(page, 'install-tenant-runtime', /installed and verified/i, 30 * 60_000, checkpoint),
        lock: await runCard(page, 'test-tenant-lock', /admitted one operation.*blocked its competitor.*recovered/i, 5 * 60_000, checkpoint),
      };
    }
    evidence.status = 'succeeded';
    evidence.finishedUtc = new Date().toISOString();
    evidence.diagnostics = { consoleErrors, networkErrors };
    await writeFile(resolve(artifactDirectory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    return Object.freeze({ evidence, artifactDirectory });
  } catch (error) {
    evidence.status = 'failed';
    evidence.finishedUtc = new Date().toISOString();
    evidence.error = redactText(error.message, 1000);
    if (page) {
      evidence.failureDiagnostic = await pageDiagnostic(page, 'failed', consoleErrors, networkErrors);
      evidence.failureScreenshot = await capture(page, artifactDirectory, 'failure');
    }
    await writeFile(resolve(artifactDirectory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    throw new Error(`${redactText(error.message, 1000)} Sanitized evidence: ${artifactDirectory}`);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
