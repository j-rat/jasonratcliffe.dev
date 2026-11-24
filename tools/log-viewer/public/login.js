// Show a sign-in error passed back by the callback (rendered as text, never HTML).
const error = new URLSearchParams(location.search).get('error');
const box = document.querySelector('[data-login-error]');
if (error && box) {
  box.textContent = `Sign-in failed: ${error.slice(0, 120)}`;
  box.hidden = false;
}
