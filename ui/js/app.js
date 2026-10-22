// Vortex Downloader v0.6.9 - Modern Monochrome Reactive UI Engine
let currentTasks = [];
let currentFilter = 'all';
let currentCategory = null;
let searchQuery = '';
let probeDebounceTimer = null;

// Format bytes into human readable format
function formatBytes(bytes, decimals = 2) {
  if (bytes <= 0 || isNaN(bytes)) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec <= 0 || isNaN(bytesPerSec)) return '0.0 MB/s';
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
}

function formatEta(seconds) {
  if (seconds <= 0 || isNaN(seconds) || !isFinite(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}h ${remMins}m`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Category Color Helper
function getCategoryColor(cat) {
  switch ((cat || '').toLowerCase()) {
    case 'video': return 'var(--cat-video)';
    case 'audio': return 'var(--cat-audio)';
    case 'images': return 'var(--cat-images)';
    case 'subtitles': return 'var(--cat-subtitles)';
    case 'documents': return 'var(--cat-documents)';
    case 'archives': return 'var(--cat-archives)';
    case 'programs': return 'var(--cat-programs)';
    default: return 'var(--cat-other)';
  }
}

// Category Icon Helper
function getCategoryIcon(cat) {
  switch ((cat || '').toLowerCase()) {
    case 'video': return '🎬';
    case 'audio': return '🎵';
    case 'images': return '🖼️';
    case 'subtitles': return '💬';
    case 'documents': return '📄';
    case 'archives': return '📦';
    case 'programs': return '⚡';
    default: return '📁';
  }
}

// Server-Sent Events Initialization
function initLiveTelemetry() {
  const evtSource = new EventSource('/api/events');

  evtSource.onmessage = function (event) {
    try {
      const data = JSON.parse(event.data);
      document.getElementById('hud-speed').textContent = formatSpeed(data.aggregate_speed);
      document.getElementById('hud-active-tasks').textContent = `${data.active_count} Active`;
      currentTasks = data.tasks || [];
      updateCategoryCounts(currentTasks);
      renderTasks();
    } catch (e) {
      console.error('SSE JSON error', e);
    }
  };

  evtSource.onerror = function () {
    document.getElementById('engine-dot').style.backgroundColor = 'var(--color-crimson)';
    setTimeout(initLiveTelemetry, 3000);
  };

  evtSource.onopen = function () {
    document.getElementById('engine-dot').style.backgroundColor = 'var(--color-emerald)';
  };
}

// Update Sidebar Badges
function updateCategoryCounts(tasks) {
  const counts = {
    all: tasks.length,
    downloading: 0,
    completed: 0,
    Video: 0,
    Audio: 0,
    Images: 0,
    Documents: 0,
    Archives: 0,
    Programs: 0,
    Other: 0,
  };

  tasks.forEach(t => {
    if (t.status === 'downloading') counts.downloading++;
    if (t.status === 'completed') counts.completed++;
    if (counts[t.category] !== undefined) {
      counts[t.category]++;
    } else {
      counts.Other++;
    }
  });

  document.getElementById('count-all').textContent = counts.all;
  document.getElementById('count-downloading').textContent = counts.downloading;
  document.getElementById('count-completed').textContent = counts.completed;
  document.getElementById('count-video').textContent = counts.Video;
  document.getElementById('count-audio').textContent = counts.Audio;
  document.getElementById('count-images').textContent = counts.Images;
  document.getElementById('count-documents').textContent = counts.Documents;
  document.getElementById('count-archives').textContent = counts.Archives;
  document.getElementById('count-programs').textContent = counts.Programs;
  document.getElementById('count-other').textContent = counts.Other;
}

// Render Tasks Cards
function renderTasks() {
  const container = document.getElementById('tasks-list');
  const emptyState = document.getElementById('empty-state');

  // Filter tasks
  let filtered = currentTasks.filter(t => {
    if (currentFilter === 'downloading' && t.status !== 'downloading') return false;
    if (currentFilter === 'completed' && t.status !== 'completed') return false;
    if (currentCategory && t.category !== currentCategory) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchName = (t.filename || '').toLowerCase().includes(q);
      const matchUrl = (t.url || '').toLowerCase().includes(q);
      if (!matchName && !matchUrl) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';
  let html = '';

  filtered.forEach(t => {
    const isDownloading = t.status === 'downloading';
    const isCompleted = t.status === 'completed';
    const isPaused = t.status === 'paused';
    const isError = t.status === 'error';

    const pct = t.total_bytes > 0
      ? Math.min(100, (t.downloaded_bytes / t.total_bytes) * 100).toFixed(1)
      : (isCompleted ? '100' : '0');

    let badgeClass = 'badge-cyan';
    if (isCompleted) badgeClass = 'badge-emerald';
    if (isPaused) badgeClass = 'badge-amber';
    if (isError) badgeClass = 'badge-crimson';

    const catColor = getCategoryColor(t.category);
    const catIcon = getCategoryIcon(t.category);

    // IDM Multi-Pipe Mock Strip (divided into segments according to threads)
    let pipesHtml = '';
    const threadCount = Math.max(1, t.threads || 8);
    for (let i = 0; i < threadCount; i++) {
      const pipePct = (i + 1) / threadCount * 100;
      let pipeState = '';
      if (parseFloat(pct) >= pipePct) {
        pipeState = 'finished';
      } else if (isDownloading && parseFloat(pct) >= (i / threadCount * 100)) {
        pipeState = 'active';
      }
      pipesHtml += `<div class="idm-pipe ${pipeState}"></div>`;
    }

    html += `
      <div class="task-card ${isDownloading ? 'active-downloading' : ''}">
        <div class="task-card-header">
          <div class="task-info-left">
            <div class="task-icon">${catIcon}</div>
            <div class="task-titles">
              <span class="task-filename" title="${t.filename}">${t.filename}</span>
              <span class="task-url" title="${t.url}">${t.url}</span>
            </div>
          </div>
          <div class="task-tags">
            <span class="badge badge-cat" style="color: ${catColor}; border-color: ${catColor}40;">
              ${t.category}
            </span>
            <span class="badge ${badgeClass}">${t.status.toUpperCase()}</span>
          </div>
        </div>

        <div class="progress-section">
          <div class="progress-track">
            <div class="progress-fill ${isCompleted ? 'completed' : ''}" style="width: ${pct}%;"></div>
          </div>
          ${!isCompleted ? `<div class="idm-segment-strip">${pipesHtml}</div>` : ''}
        </div>

        <div class="task-meta-stats">
          <div class="meta-left">
            <span>${pct}%</span>
            <span>${formatBytes(t.downloaded_bytes)} / ${t.total_bytes > 0 ? formatBytes(t.total_bytes) : 'Indeterminate'}</span>
            ${isDownloading ? `<span class="meta-speed">${formatSpeed(t.speed)}</span>` : ''}
            ${isDownloading && t.eta > 0 ? `<span class="meta-eta">ETA ${formatEta(t.eta)}</span>` : ''}
            <span style="color: var(--text-muted);">${t.threads || 8} Pipes</span>
          </div>

          <div class="task-card-actions">
            ${isDownloading ? `
              <button class="btn btn-amber btn-sm" onclick="pauseTask('${t.id}')">Pause</button>
            ` : ''}
            ${isPaused ? `
              <button class="btn btn-cyan btn-sm" onclick="resumeTask('${t.id}')">Resume</button>
            ` : ''}
            ${isCompleted ? `
              <button class="btn btn-primary btn-sm" onclick="openFile('${t.id}')">Open File</button>
              <button class="btn btn-secondary btn-sm" onclick="openFolder('${t.id}')">Open Folder</button>
            ` : ''}
            <button class="btn btn-secondary btn-sm" onclick="deleteTask('${t.id}')" title="Delete Task">🗑️</button>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Filter Navigation
function setFilter(filter, el) {
  currentFilter = filter;
  currentCategory = null;
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');

  const titles = {
    all: 'All Downloads',
    downloading: 'Active Downloads',
    completed: 'Completed Downloads',
  };
  document.getElementById('view-title').textContent = titles[filter] || 'Downloads';
  renderTasks();
}

function setCategoryFilter(category, el) {
  currentFilter = 'all';
  currentCategory = category;
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('view-title').textContent = `${category} Downloads`;
  renderTasks();
}

function onSearchInput(val) {
  searchQuery = val.trim();
  renderTasks();
}

// Modal Controllers
function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function openAddTaskModal() {
  document.getElementById('add-url').value = '';
  document.getElementById('add-filename').value = '';
  document.getElementById('probe-card').style.display = 'none';
  openModal('modal-add-task');
  document.getElementById('add-url').focus();
}

function openSettingsModal() {
  fetch('/api/settings')
    .then(r => r.json())
    .then(s => {
      document.getElementById('setting-download-path').value = s.download_path;
      document.getElementById('setting-threads').value = s.pre_allocated_threads;
      document.getElementById('setting-speed-boost').checked = s.auto_speed_boost;
      document.getElementById('setting-auto-categorize').checked = s.auto_categorize;
      document.getElementById('setting-protocol-vortex').checked = s.protocol_vortex;
      document.getElementById('setting-pair-token').value = s.pair_token;
      openModal('modal-settings');
    });
}

function saveSettings() {
  const payload = {
    download_path: document.getElementById('setting-download-path').value,
    pre_allocated_threads: parseInt(document.getElementById('setting-threads').value) || 8,
    auto_speed_boost: document.getElementById('setting-speed-boost').checked,
    auto_categorize: document.getElementById('setting-auto-categorize').checked,
    protocol_vortex: document.getElementById('setting-protocol-vortex').checked,
    pair_token: document.getElementById('setting-pair-token').value,
    duplicate_action: 'keep_both',
    browser_extension_enabled: true,
    speed_limit: 0,
    max_active_tasks: 3,
    open_torrent: true,
    open_magnet: true,
    open_ed2k: true,
    open_ftp: true,
    open_m3u8: true,
  };

  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(() => {
    closeModal('modal-settings');
  });
}

function openVaultModal() {
  openModal('modal-vault');
}

// URL Auto-Probe
function onUrlInput(url) {
  clearTimeout(probeDebounceTimer);
  const cleanUrl = url.trim();
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    document.getElementById('probe-card').style.display = 'none';
    return;
  }

  probeDebounceTimer = setTimeout(() => {
    fetch('/api/tasks/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: cleanUrl }),
    })
      .then(r => r.json())
      .then(res => {
        document.getElementById('probe-card').style.display = 'flex';
        document.getElementById('probe-filename').textContent = res.filename;
        document.getElementById('probe-size').textContent = res.total_bytes > 0 ? formatBytes(res.total_bytes) : 'Indeterminate / Stream';
        document.getElementById('probe-range-badge').textContent = res.accepts_ranges ? 'ACCEPT-RANGES: YES' : 'NO RANGE';
        if (!document.getElementById('add-filename').value) {
          document.getElementById('add-filename').value = res.filename;
        }
      })
      .catch(() => {
        document.getElementById('probe-card').style.display = 'none';
      });
  }, 400);
}

// Task Actions
function submitNewTask() {
  const url = document.getElementById('add-url').value.trim();
  const filename = document.getElementById('add-filename').value.trim();
  const threads = parseInt(document.getElementById('add-threads').value) || 8;

  if (!url) return;

  fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, filename: filename || undefined, threads }),
  }).then(() => {
    closeModal('modal-add-task');
  });
}

function pauseTask(id) {
  fetch(`/api/tasks/${id}/pause`, { method: 'POST' });
}

function resumeTask(id) {
  fetch(`/api/tasks/${id}/resume`, { method: 'POST' });
}

function deleteTask(id) {
  if (confirm('Delete this download task?')) {
    fetch(`/api/tasks/${id}`, { method: 'DELETE' });
  }
}

function openFile(id) {
  fetch(`/api/tasks/${id}/open_file`, { method: 'POST' });
}

function openFolder(id) {
  fetch(`/api/tasks/${id}/open_folder`, { method: 'POST' });
}

function pauseAllTasks() {
  currentTasks.forEach(t => {
    if (t.status === 'downloading') pauseTask(t.id);
  });
}

function resumeAllTasks() {
  currentTasks.forEach(t => {
    if (t.status === 'paused') resumeTask(t.id);
  });
}

// Initial Boot
window.addEventListener('DOMContentLoaded', () => {
  initLiveTelemetry();
});
