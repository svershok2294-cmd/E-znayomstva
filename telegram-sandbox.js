import { readFileSync } from 'node:fs';

export function loadTelegramSandbox(env) {
  if (env.TELEGRAM_BOT_TEST_MODE !== 'true') return null;

  const projectId = env.FIREBASE_TEST_PROJECT_ID || '';
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ||
      ['nazviazku', 'nazviazku-38b50'].includes(projectId)) {
    throw new Error('Telegram test mode requires a separate Firebase project');
  }
  if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(env.APP_ORIGIN || '')) {
    throw new Error('Telegram test mode requires its own HTTPS origin');
  }
  if (!/^[A-Za-z0-9_]{5,32}$/.test(env.TELEGRAM_TEST_BOT_USERNAME || '')) {
    throw new Error('Telegram test mode requires the test bot username');
  }

  let config;
  try { config = JSON.parse(env.FIREBASE_TEST_WEB_CONFIG || ''); }
  catch { throw new Error('Invalid Firebase test web configuration'); }
  if (config?.projectId !== projectId || !config.apiKey || !config.appId ||
      config.authDomain !== projectId + '.firebaseapp.com') {
    throw new Error('Firebase test web configuration does not match the isolated project');
  }
  const publicConfig = JSON.stringify({
    projectId, apiKey: config.apiKey, appId: config.appId, authDomain: config.authDomain
  }).replace(/</g, '\\u003c');
  const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
    .replace("const appApiOrigin = 'https://e-znayomstva-auth.onrender.com';", "const appApiOrigin = '';")
    .replace("const appBotUrl = 'https://t.me/e_znayomstva_bot';", "const appBotUrl = 'https://t.me/" + env.TELEGRAM_TEST_BOT_USERNAME + "';")
    .replace(/const firebaseConfig = \{[\s\S]*?\n        \};/, () => 'const firebaseConfig = ' + publicConfig + ';')
    .replace('<title>Е - Знайомства | Production Cloud Edition</title>', '<title>Е - Знайомства | Telegram Test</title>')
    .replace('class="logo">Е-ЗНАЙОМСТВА</div>', 'class="logo">Е-ЗНАЙОМСТВА · ТЕСТ</div>');
  if (page.includes('e-znayomstva-auth.onrender.com') || page.includes('nazviazku.firebaseapp.com') ||
      !page.includes('const firebaseConfig = ' + publicConfig + ';')) {
    throw new Error('Could not isolate the Telegram test client');
  }
  return { projectId, origin: env.APP_ORIGIN, page };
}
