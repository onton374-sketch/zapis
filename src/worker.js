import page from "../docs/index.html";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_BODY = 4096;

const hits = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(page, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=60",
          "x-content-type-options": "nosniff",
          "referrer-policy": "same-origin",
          "content-security-policy":
            "default-src 'self'; base-uri 'none'; form-action 'self'; " +
            "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; connect-src 'self'"
        }
      });
    }

    if (url.pathname === "/api/book") {
      if (request.method === "OPTIONS") return preflight(env);
      if (request.method !== "POST") return json({ ok: false, error: "Метод не поддерживается." }, 405, env);
      return handleBook(request, env);
    }

    return new Response("Не найдено", { status: 404 });
  }
};

async function handleBook(request, env) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) {
    return json({ ok: false, error: "Ожидается JSON." }, 415, env);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    return json({ ok: false, error: "Слишком большой запрос." }, 413, env);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Не удалось прочитать данные." }, 400, env);
  }

  // Honeypot: people never see this field, bots fill it in.
  if (body && typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: true }, 200, env);
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (tooManyRequests(ip)) {
    return json({ ok: false, error: "Слишком много заявок подряд. Попробуйте через несколько минут." }, 429, env);
  }

  const name = text(body.name, 80);
  const phone = text(body.phone, 32);
  const comment = text(body.comment, 300);
  const date = text(body.date, 10);
  const time = text(body.time, 5);

  if (name.length < 2) return json({ ok: false, error: "Напишите имя." }, 400, env);
  if (!isContact(phone)) return json({ ok: false, error: "Оставьте телефон или Telegram." }, 400, env);
  if (!DATE_RE.test(date) || !isRealDate(date) || !inRange(date)) {
    return json({ ok: false, error: "Выберите корректную дату." }, 400, env);
  }
  if (!TIME_RE.test(time)) return json({ ok: false, error: "Выберите корректное время." }, 400, env);

  if (!env.BOT_TOKEN || !env.CHAT_ID) {
    console.error("BOT_TOKEN or CHAT_ID is not configured");
    return json({ ok: false, error: "Запись временно недоступна. Напишите напрямую." }, 500, env);
  }

  const message = [
    "Новая заявка на запись",
    "",
    "Имя: " + name,
    "Контакт: " + phone,
    "Когда: " + formatDate(date) + ", " + time,
    comment ? "Комментарий: " + comment : ""
  ].filter(Boolean).join("\n");

  try {
    for (const chatId of String(env.CHAT_ID).split(",").map((s) => s.trim()).filter(Boolean)) {
      await sendMessage(env, chatId, message);
    }
  } catch (err) {
    console.error("telegram send failed", err && err.stack ? err.stack : err);
    return json({ ok: false, error: "Не удалось отправить заявку. Попробуйте ещё раз." }, 502, env);
  }

  return json({ ok: true }, 200, env);
}

async function sendMessage(env, chatId, text) {
  const base = env.TELEGRAM_API_BASE || "https://api.telegram.org";
  const res = await fetch(base + "/bot" + env.BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error("Telegram " + res.status + ": " + detail.slice(0, 300));
  }
}

function isContact(value) {
  if (value.replace(/\D/g, "").length >= 5) return true;
  return /^@?[A-Za-z0-9_]{4,32}$/.test(value);
}

function text(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function isRealDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function inRange(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const at = Date.UTC(y, m - 1, d);
  const now = Date.now();
  return at >= now - 2 * 86400000 && at <= now + 120 * 86400000;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-");
  return d + "." + m + "." + y;
}

function tooManyRequests(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return false;
}

function preflight(env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

function corsHeaders(env) {
  const allowed = env.ALLOWED_ORIGIN;
  if (!allowed) return {};
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin"
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(env)
    }
  });
}
