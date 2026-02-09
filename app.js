const canvas = document.getElementById("graffiti-canvas");
const ctx = canvas.getContext("2d");
const pixelCountEl = document.getElementById("pixel-count");
const refreshBtn = document.getElementById("refresh-btn");

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
  // Fill white
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

async function loadCanvas() {
  try {
    refreshBtn.textContent = "Loading...";
    const res = await fetch("/api/canvas");
    const data = await res.json();
    renderCanvas(data);
  } catch (err) {
    console.error("Failed to load canvas:", err);
    pixelCountEl.textContent = "Failed to load canvas";
  } finally {
    refreshBtn.textContent = "Refresh";
  }
}

refreshBtn.addEventListener("click", loadCanvas);

// Load on start
loadCanvas();
