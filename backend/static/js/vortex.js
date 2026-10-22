/**
 * Vortex Downloader Client-Side Micro-Interactions & Audio Chimes
 */

// Toast notification helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const bg = type === 'success' ? 'bg-emerald-600/90 text-white border-emerald-400' :
             type === 'error' ? 'bg-red-600/90 text-white border-red-400' :
             'bg-[#2b2b30]/95 text-cyan-300 border-[#3ea6ff]/40';

  toast.className = `px-4 py-2.5 rounded-xl border shadow-xl text-xs font-sans font-medium flex items-center space-x-2 transition-all duration-300 transform translate-y-2 opacity-0 backdrop-blur-md ${bg}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Copy to clipboard with toast feedback
function copyToClipboard(text, label = "Copied to clipboard!") {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(label, 'success');
    }).catch(() => {
      showToast("Failed to copy", 'error');
    });
  } else {
    const input = document.createElement('input');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    showToast(label, 'success');
  }
}

// Play modern clean audio chime upon download completion
function playCompletionChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.exponentialRampToValueAtTime(880.00, ctx.currentTime + 0.15); // A5

    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (_) {}
}

// Modal open/close helpers
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

// Close modals when clicking backdrop or pressing Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.vortex-modal').forEach(m => {
      m.classList.add('hidden');
      m.classList.remove('flex');
    });
  }
});

// Format selection handler for Add Task Modal
function selectFormat(elem, formatId, resolution, category, ext, directUrl = '') {
  document.querySelectorAll('.format-chip').forEach(c => {
    c.classList.remove('border-[#3ea6ff]', 'bg-[#3ea6ff]/15', 'text-white');
    c.classList.add('border-white/[0.08]', 'text-gray-300');
  });
  elem.classList.add('border-[#3ea6ff]', 'bg-[#3ea6ff]/15', 'text-white');
  elem.classList.remove('border-white/[0.08]', 'text-gray-300');

  const fInput = document.getElementById('selected-format-id');
  if (fInput) fInput.value = formatId;

  const rInput = document.getElementById('selected-resolution');
  if (rInput) rInput.value = resolution;

  const cInput = document.getElementById('selected-category');
  if (cInput) cInput.value = directUrl ? 'DIRECT' : category;

  const eInput = document.getElementById('selected-extension');
  if (eInput) eInput.value = ext;

  if (directUrl) {
    const urlInput = document.getElementById('task-url-input');
    if (urlInput) urlInput.value = directUrl;
  }
}

// Toggle Chunk Stream Visualizer
function toggleVisualizer(taskId) {
  const drawer = document.getElementById(`visualizer-${taskId}`);
  if (drawer) {
    drawer.classList.toggle('hidden');
  }
}

// Clipboard URL auto-monitoring on window focus
let lastClipboardText = '';
window.addEventListener('focus', async () => {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = (await navigator.clipboard.readText()).trim();
      if (
        text &&
        text !== lastClipboardText &&
        (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('magnet:?'))
      ) {
        lastClipboardText = text;
        const addModal = document.getElementById('add-task-modal');
        if (addModal && addModal.classList.contains('hidden')) {
          showToast(`Clipboard stream link detected! Ready in New Task.`, 'info');
          const taskInput = document.getElementById('task-url-input');
          if (taskInput) {
            taskInput.value = text;
            htmx.trigger(taskInput, 'input');
          }
        }
      }
    }
  } catch (_) {}
});
