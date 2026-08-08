window.addEventListener('error', function(event) {
    const el = document.getElementById('status-bar');
    if (el) {
        el.textContent = 'ERR: ' + event.message;
        el.className = 'status-error';
    } else {
        console.error('ERR:', event.message);
    }
});
window.addEventListener('unhandledrejection', function(event) {
    const el = document.getElementById('status-bar');
    if (el) {
        el.textContent = 'UNHANDLED: ' + event.reason;
        el.className = 'status-error';
    } else {
        console.error('UNHANDLED:', event.reason);
    }
});
