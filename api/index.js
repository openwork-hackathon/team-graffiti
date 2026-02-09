import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

let _redis;
function getRedis() {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}

const CANVAS_W = 640;
const CANVAS_H = 480;
const MAX_PIXELS_PER_PAINT = 20;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res, data, status = 200) {
  cors(res);
  res.status(status).json(data);
}

// --- Handlers ---

async function handleRegister(req, res) {
  const { name } = req.body || {};
  if (!name || typeof name !== "string" || name.trim().length < 2) {
    return json(res, { error: "name is required (min 2 chars)" }, 400);
  }

  const cleanName = name.trim().slice(0, 32);

  const existing = await getRedis().hget("graffiti:agents:names", cleanName.toLowerCase());
  if (existing) {
    return json(res, { error: "name already taken" }, 409);
  }

  const apiKey = "grf_" + crypto.randomBytes(24).toString("hex");
  const agent = {
    name: cleanName,
    api_key: apiKey,
    created_at: new Date().toISOString(),
    pixels_painted: 0,
  };

  await getRedis().hset("graffiti:agents", { [apiKey]: JSON.stringify(agent) });
  await getRedis().hset("graffiti:agents:names", { [cleanName.toLowerCase()]: apiKey });

  return json(res, {
    name: cleanName,
    api_key: apiKey,
    message: "Welcome to Graffiti! Use your API key to paint pixels.",
    canvas_size: { width: CANVAS_W, height: CANVAS_H },
    max_pixels_per_request: MAX_PIXELS_PER_PAINT,
  });
}

async function handlePaint(req, res) {
  const auth = req.headers.authorization || "";
  const apiKey = auth.replace(/^Bearer\s+/i, "").trim();

  if (!apiKey) {
    return json(res, { error: "Authorization header required: Bearer grf_xxx" }, 401);
  }

  const agentData = await getRedis().hget("graffiti:agents", apiKey);
  if (!agentData) {
    return json(res, { error: "invalid API key" }, 401);
  }

  const agent = typeof agentData === "string" ? JSON.parse(agentData) : agentData;
  const { color, pixels } = req.body || {};

  if (!color || !Array.isArray(color) || color.length !== 3) {
    return json(res, { error: "color must be [r, g, b] array" }, 400);
  }
  for (const c of color) {
    if (typeof c !== "number" || c < 0 || c > 255 || !Number.isInteger(c)) {
      return json(res, { error: "color values must be integers 0-255" }, 400);
    }
  }

  if (!pixels || !Array.isArray(pixels) || pixels.length === 0) {
    return json(res, { error: "pixels must be a non-empty array of [row, col] pairs" }, 400);
  }
  if (pixels.length > MAX_PIXELS_PER_PAINT) {
    return json(res, { error: `max ${MAX_PIXELS_PER_PAINT} pixels per request` }, 400);
  }

  const colorHex =
    color[0].toString(16).padStart(2, "0") +
    color[1].toString(16).padStart(2, "0") +
    color[2].toString(16).padStart(2, "0");

  const updates = {};
  const painted = [];

  for (const px of pixels) {
    if (!Array.isArray(px) || px.length !== 2) {
      return json(res, { error: "each pixel must be [row, col]" }, 400);
    }
    const [row, col] = px;
    if (
      typeof row !== "number" || typeof col !== "number" ||
      !Number.isInteger(row) || !Number.isInteger(col) ||
      row < 0 || row >= CANVAS_H || col < 0 || col >= CANVAS_W
    ) {
      return json(res, {
        error: `pixel [${row}, ${col}] out of bounds. Canvas is ${CANVAS_H} rows x ${CANVAS_W} cols`,
      }, 400);
    }
    updates[`${row},${col}`] = colorHex;
    painted.push([row, col]);
  }

  await getRedis().hset("graffiti:canvas", updates);

  agent.pixels_painted = (agent.pixels_painted || 0) + painted.length;
  await getRedis().hset("graffiti:agents", { [apiKey]: JSON.stringify(agent) });

  await getRedis().lpush("graffiti:log", JSON.stringify({
    agent: agent.name,
    color: colorHex,
    pixels: painted,
    time: new Date().toISOString(),
  }));
  await getRedis().ltrim("graffiti:log", 0, 999);

  return json(res, {
    painted: painted.length,
    color: color,
    agent: agent.name,
    total_painted: agent.pixels_painted,
  });
}

async function handleCanvas(req, res) {
  const data = await getRedis().hgetall("graffiti:canvas");
  return json(res, {
    width: CANVAS_W,
    height: CANVAS_H,
    pixels: data || {},
  });
}

async function handleAgents(req, res) {
  const data = await getRedis().hgetall("graffiti:agents");
  if (!data) return json(res, { agents: [] });

  const agents = Object.values(data).map((v) => {
    const a = typeof v === "string" ? JSON.parse(v) : v;
    return { name: a.name, pixels_painted: a.pixels_painted, created_at: a.created_at };
  });

  agents.sort((a, b) => (b.pixels_painted || 0) - (a.pixels_painted || 0));
  return json(res, { agents });
}

async function handleLog(req, res) {
  const entries = await getRedis().lrange("graffiti:log", 0, 49);
  const log = (entries || []).map((e) => (typeof e === "string" ? JSON.parse(e) : e));
  return json(res, { log });
}

// --- Router ---

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  if (method === "OPTIONS") {
    cors(res);
    return res.status(204).end();
  }

  try {
    if (path === "/api/register" && method === "POST") return handleRegister(req, res);
    if (path === "/api/paint" && method === "POST") return handlePaint(req, res);
    if (path === "/api/canvas" && method === "GET") return handleCanvas(req, res);
    if (path === "/api/agents" && method === "GET") return handleAgents(req, res);
    if (path === "/api/log" && method === "GET") return handleLog(req, res);

    return json(res, { error: "not found", routes: ["/api/register", "/api/paint", "/api/canvas", "/api/agents", "/api/log"] }, 404);
  } catch (err) {
    return json(res, { error: "internal error", message: err.message }, 500);
  }
}
