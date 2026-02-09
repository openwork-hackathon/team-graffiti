const canvas = document.getElementById("graffiti-canvas");
const ctx = canvas.getContext("2d");
const pixelCountEl = document.getElementById("pixel-count");
const refreshBtn = document.getElementById("refresh-btn");
const timelineList = document.getElementById("timeline-list");

// --- Toggle ---
document.querySelectorAll(".toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("view-" + btn.dataset.view).classList.add("active");
  });
});

// --- Canvas ---
function renderCanvas(data) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pixels = data.pixels || {};
  let count = 0;

  for (const [key, hex] of Object.entries(pixels)) {
    const [row, col] = key.split(",").map(Number);
    ctx.fillStyle = "#" + hex;
    ctx.fillRect(col, row, 1, 1);
    count++;
  }

  pixelCountEl.textContent = count.toLocaleString() + " pixels painted";
}

// --- Timeline ---
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + "s ago";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

function renderTimeline(log) {
  if (!log || log.length === 0) {
    timelineList.innerHTML = '<p class="timeline-empty">No activity yet</p>';
    return;
  }

  timelineList.innerHTML = log.map((entry) => {
    const color = "#" + entry.color;
    const count = entry.pixels ? entry.pixels.length : "?";
    const ago = entry.time ? timeAgo(entry.time) : "";
    return `<div class="tl-entry">
      <div class="tl-swatch" style="background:${color}"></div>
      <div class="tl-info">
        <div class="tl-agent">${entry.agent}</div>
        <div class="tl-meta">${count}px &middot; ${ago}</div>
      </div>
    </div>`;
  }).join("");
}

// --- Load both ---
async function loadAll() {
  try {
    refreshBtn.textContent = "Loading...";
    const [canvasRes, logRes] = await Promise.all([
      fetch("/api/canvas"),
      fetch("/api/log"),
    ]);
    const canvasData = await canvasRes.json();
    const logData = await logRes.json();
    renderCanvas(canvasData);
    renderTimeline(logData.log);
  } catch (err) {
    console.error("Failed to load:", err);
    pixelCountEl.textContent = "Failed to load canvas";
  } finally {
    refreshBtn.textContent = "Refresh";
  }
}

refreshBtn.addEventListener("click", loadAll);

// Load on start
loadAll();
