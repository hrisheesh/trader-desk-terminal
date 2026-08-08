window.addEventListener('error', function(e) {
  fetch('/api/log-error', { method: 'POST', body: e.message });
});
