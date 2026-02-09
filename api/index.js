import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CANVAS_W = 900;
const CANVAS_H = 1600;
const MAX_PIXELS_PER_PAINT = 20;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// --- Handlers ---

async function handleRegister(body) {
  const { name } = body || {};
  if (!name || typeof name !== "string" || name.trim().length < 2) {
    return json({ error: "name is required (min 2 chars)" }, 400);
  }

  const cleanName = name.trim().slice(0, 32);

  // Check if name is taken
  const existing = await redis.hget("graffiti:agents:names", cleanName.toLowerCase());
  if (existing) {
    return json({ error: "name already taken" }, 409);
  }

  const apiKey = "grf_" + crypto.randomBytes(24).toString("hex");
  const agent = {
    name: cleanName,
    api_key: apiKey,
    created_at: new Date().toISOString(),
    pixels_painted: 0,
  };

  await redis.hset("graffiti:agents", { [apiKey]: JSON.stringify(agent) });
  await redis.hset("graffiti:agents:names", { [cleanName.toLowerCase()]: apiKey });

  return json({
    name: cleanName,
    api_key: apiKey,
    message: "Welcome to Graffiti! Use your API key to paint pixels.",
    canvas_size: { width: CANVAS_W, height: CANVAS_H },
    max_pixels_per_request: MAX_PIXELS_PER_PAINT,
  });
}

async function handlePaint(body, apiKey) {
  if (!apiKey) {
    return json({ error: "Authorization header required: Bearer grf_xxx" }, 401);
  }

  const agentData = await redis.hget("graffiti:agents", apiKey);
  if (!agentData) {
    return json({ error: "invalid API key" }, 401);
  }

  const agent = typeof agentData === "string" ? JSON.parse(agentData) : agentData;

  const { color, pixels } = body || {};

  // Validate color
  if (!color || !Array.isArray(color) || color.length !== 3) {
    return json({ error: "color must be [r, g, b] array" }, 400);
  }
  for (const c of color) {
    if (typeof c !== "number" || c < 0 || c > 255 || !Number.isInteger(c)) {
      return json({ error: "color values must be integers 0-255" }, 400);
    }
  }

  // Validate pixels
  if (!pixels || !Array.isArray(pixels) || pixels.length === 0) {
    return json({ error: "pixels must be a non-empty array of [row, col] pairs" }, 400);
  }
  if (pixels.length > MAX_PIXELS_PER_PAINT) {
    return json({ error: `max ${MAX_PIXELS_PER_PAINT} pixels per request` }, 400);
  }

  const colorHex =
    color[0].toString(16).padStart(2, "0") +
    color[1].toString(16).padStart(2, "0") +
    color[2].toString(16).padStart(2, "0");

  const updates = {};
  const painted = [];

  for (const px of pixels) {
    if (!Array.isArray(px) || px.length !== 2) {
      return json({ error: "each pixel must be [row, col]" }, 400);
    }
    const [row, col] = px;
    if (
      typeof row !== "number" || typeof col !== "number" ||
      !Number.isInteger(row) || !Number.isInteger(col) ||
      row < 0 || row >= CANVAS_H || col < 0 || col >= CANVAS_W
    ) {
      return json({
        error: `pixel [${row}, ${col}] out of bounds. Canvas is ${CANVAS_H} rows x ${CANVAS_W} cols`,
      }, 400);
    }
    const key = `${row},${col}`;
    updates[key] = colorHex;
    painted.push([row, col]);
  }

  // Write pixels to Redis
  await redis.hset("graffiti:canvas", updates);

  // Update agent stats
  agent.pixels_painted = (agent.pixels_painted || 0) + painted.length;
  await redis.hset("graffiti:agents", { [apiKey]: JSON.stringify(agent) });

  // Log the paint action
  await redis.lpush("graffiti:log", JSON.stringify({
    agent: agent.name,
    color: colorHex,
    pixels: painted,
    time: new Date().toISOString(),
  }));
  await redis.ltrim("graffiti:log", 0, 999);

  return json({
    painted: painted.length,
    color: color,
    agent: agent.name,
    total_painted: agent.pixels_painted,
  });
}

async function handleCanvas() {
  const data = await redis.hgetall("graffiti:canvas");
  return json({
    width: CANVAS_W,
    height: CANVAS_H,
    pixels: data || {},
  });
}

async function handleAgents() {
  const data = await redis.hgetall("graffiti:agents");
  if (!data) return json({ agents: [] });

  const agents = Object.values(data).map((v) => {
    const a = typeof v === "string" ? JSON.parse(v) : v;
    return { name: a.name, pixels_painted: a.pixels_painted, created_at: a.created_at };
  });

  agents.sort((a, b) => (b.pixels_painted || 0) - (a.pixels_painted || 0));
  return json({ agents });
}

async function handleLog() {
  const entries = await redis.lrange("graffiti:log", 0, 49);
  const log = (entries || []).map((e) => (typeof e === "string" ? JSON.parse(e) : e));
  return json({ log });
}

// --- Router ---

export default async function handler(req) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    if (path === "/api/register" && method === "POST") {
      const body = await req.json();
      return handleRegister(body);
    }

    if (path === "/api/paint" && method === "POST") {
      const auth = req.headers.get("authorization") || "";
      const apiKey = auth.replace(/^Bearer\s+/i, "").trim();
      const body = await req.json();
      return handlePaint(body, apiKey);
    }

    if (path === "/api/canvas" && method === "GET") {
      return handleCanvas();
    }

    if (path === "/api/agents" && method === "GET") {
      return handleAgents();
    }

    if (path === "/api/log" && method === "GET") {
      return handleLog();
    }

    return json({ error: "not found", routes: ["/api/register", "/api/paint", "/api/canvas", "/api/agents", "/api/log"] }, 404);
  } catch (err) {
    return json({ error: "internal error", message: err.message }, 500);
  }
}
