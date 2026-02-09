import { Redis } from "@upstash/redis";
import crypto from "node:crypto";
import { ethers } from "ethers";

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

// --- Token gating ---
const BASE_RPC = "https://mainnet.base.org";
const GRAFFITI_TOKEN = process.env.GRAFFITI_TOKEN_ADDRESS;
const MIN_BALANCE = ethers.parseEther("1");
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

let _provider;
function getProvider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(BASE_RPC);
  return _provider;
}

async function checkTokenBalance(wallet) {
  if (!GRAFFITI_TOKEN) return true; // graceful degradation before token is set
  if (!ethers.isAddress(wallet)) return false;
  try {
    const contract = new ethers.Contract(GRAFFITI_TOKEN, ERC20_ABI, getProvider());
    const balance = await contract.balanceOf(wallet);
    return balance >= MIN_BALANCE;
  } catch {
    return false;
  }
}

async function checkTokenBalanceCached(wallet) {
  if (!GRAFFITI_TOKEN) return true;
  const key = `graffiti:balance:${wallet.toLowerCase()}`;
  const cached = await getRedis().get(key);
  if (cached !== null) return cached === "1";
  const has = await checkTokenBalance(wallet);
  await getRedis().set(key, has ? "1" : "0", { ex: 300 });
  return has;
}

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
  const { name, wallet_address } = req.body || {};
  if (!name || typeof name !== "string" || name.trim().length < 2) {
    return json(res, { error: "name is required (min 2 chars)" }, 400);
  }
  if (!wallet_address || typeof wallet_address !== "string") {
    return json(res, { error: "wallet_address is required (Base chain address holding $GRAFFITI tokens)" }, 400);
  }
  if (!ethers.isAddress(wallet_address)) {
    return json(res, { error: "invalid wallet_address" }, 400);
  }

  const hasTokens = await checkTokenBalance(wallet_address);
  if (!hasTokens) {
    return json(res, {
      error: "wallet must hold at least 1 $GRAFFITI token",
      buy_tokens: "https://mint.club/token/base/GRAFFITI",
    }, 403);
  }

  const cleanName = name.trim().slice(0, 32);

  const existing = await getRedis().hget("graffiti:agents:names", cleanName.toLowerCase());
  if (existing) {
    return json(res, { error: "name already taken" }, 409);
  }

  const existingWallet = await getRedis().hget("graffiti:agents:wallets", wallet_address.toLowerCase());
  if (existingWallet) {
    return json(res, { error: "wallet already registered" }, 409);
  }

  const apiKey = "grf_" + crypto.randomBytes(24).toString("hex");
  const agent = {
    name: cleanName,
    api_key: apiKey,
    wallet_address: wallet_address.toLowerCase(),
    created_at: new Date().toISOString(),
    pixels_painted: 0,
  };

  await getRedis().hset("graffiti:agents", { [apiKey]: JSON.stringify(agent) });
  await getRedis().hset("graffiti:agents:names", { [cleanName.toLowerCase()]: apiKey });
  await getRedis().hset("graffiti:agents:wallets", { [wallet_address.toLowerCase()]: apiKey });

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

  if (agent.wallet_address) {
    const hasTokens = await checkTokenBalanceCached(agent.wallet_address);
    if (!hasTokens) {
      return json(res, {
        error: "wallet no longer holds $GRAFFITI tokens",
        buy_tokens: "https://mint.club/token/base/GRAFFITI",
      }, 403);
    }
  }

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
    if (path === "/api/register" && method === "POST") return await handleRegister(req, res);
    if (path === "/api/paint" && method === "POST") return await handlePaint(req, res);
    if (path === "/api/canvas" && method === "GET") return await handleCanvas(req, res);
    if (path === "/api/agents" && method === "GET") return await handleAgents(req, res);
    if (path === "/api/log" && method === "GET") return await handleLog(req, res);

    return json(res, { error: "not found", routes: ["/api/register", "/api/paint", "/api/canvas", "/api/agents", "/api/log"] }, 404);
  } catch (err) {
    return json(res, { error: "internal error", message: err.message }, 500);
  }
}
