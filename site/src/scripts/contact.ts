// Posts the contact form to /api/contact, which CloudFront routes to the
// contact API on the same origin (so no CORS and no third-party endpoint in the CSP).

export function initContactForm(): void {
  const form = document.querySelector<HTMLFormElement>('[data-contact-form]');
  if (!form) return;
  const status = form.querySelector<HTMLElement>('[data-contact-status]')!;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  const say = (msg: string, state: 'ok' | 'err' | '') => {
    status.textContent = msg;
    status.dataset.state = state;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    button.disabled = true;
    say('Sending…', '');
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        form.reset();
        say('Thanks – your message is on its way. I’ll reply soon.', 'ok');
      } else if (res.status === 429) {
        say('Too many messages right now. Please try again in a minute, or use LinkedIn.', 'err');
      } else if (res.status === 400) {
        say('Please check the fields and try again.', 'err');
      } else {
        say('Something went wrong sending that. Please try LinkedIn instead.', 'err');
      }
    } catch {
      say('Network error. Please try again or use LinkedIn.', 'err');
    } finally {
      button.disabled = false;
    }
  });
}
