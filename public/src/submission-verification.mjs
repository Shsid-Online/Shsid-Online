let scriptPromise;
let checking = false;

function loadVerificationScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    const timer = setTimeout(() => fail(), 15000);
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      scriptPromise = null;
      reject(new Error('Could not load verification. Your draft is still here; please try again.'));
    };
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timer);
      if (window.turnstile) resolve(window.turnstile);
      else fail();
    };
    document.head.append(script);
  });
  return scriptPromise;
}

// Loaded only on submission. The host lives outside #app so rendering the feed
// cannot destroy an in-progress check or discard the user's draft.
export async function submissionToken(siteKey, action) {
  if (checking) throw new Error('Another submission is being prepared. Please wait a moment.');
  if (!siteKey) throw new Error('Posting is temporarily unavailable. Your draft has not been sent.');
  checking = true;
  let host;
  try {
    const turnstile = await loadVerificationScript();
    return await new Promise((resolve, reject) => {
      host = document.createElement('section');
      host.className = 'submission-check';
      host.setAttribute('aria-label', 'Submission verification');
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      status.textContent = 'Preparing your post…';
      const widget = document.createElement('div');
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'board-button';
      cancel.textContent = 'Cancel';
      host.append(status, widget, cancel);
      document.body.append(host);
      let widgetId;
      let settled = false;
      const finish = (error, token) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (widgetId !== undefined) turnstile.remove(widgetId);
        host.remove();
        if (error) reject(new Error(error));
        else resolve(token);
      };
      const timer = setTimeout(() => finish('Verification took too long. Your draft is still here; please try again.'), 120000);
      cancel.addEventListener('click', () => finish('Submission cancelled. Your draft is still here.'));
      try {
        widgetId = turnstile.render(widget, {
          sitekey: siteKey, action, appearance: 'interaction-only', theme: 'auto',
          retry: 'never', 'refresh-expired': 'never',
          callback: token => finish(null, token),
          'error-callback': () => { finish('Verification could not complete. Your draft is still here; please try again.'); return true; },
          'expired-callback': () => finish('Verification expired. Please try posting again.'),
          'timeout-callback': () => finish('Verification timed out. Please try posting again.')
        });
      } catch {
        finish('Could not start verification. Your draft is still here; please try again.');
      }
    });
  } finally {
    host?.remove();
    checking = false;
  }
}
