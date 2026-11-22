import page from "../docs/index.html";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_BODY = 4096;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 45;

const hits = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
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

    if (path === "/api/slots") {
      if (request.method === "OPTIONS") return preflight(env);
      if (request.method !== "GET") return json({ ok: false, error: "Метод не поддерживается." }, 405, env);
      return handleSlots(url, env);
    }

    if (path === "/api/book") {
      if (request.method === "OPTIONS") return preflight(env);
      if (request.method !== "POST") return json({ ok: false, error: "Метод не поддерживается." }, 405, env);
      return handleBook(request, env);
    }

    // Сюда стучится Telegram: нажатия на кнопки и команды владельца.
    if (path === "/api/telegram") {
      if (request.method !== "POST") return new Response("ok");
      return handleUpdate(request, env);
    }

    // Одноразовая настройка бота после деплоя.
    if (path === "/api/setup") {
      if (request.method !== "GET") return new Response("ok");
      return handleSetup(url, env);
    }

    return new Response("Не найдено", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDaily(env));
  }
};

/* ---------- Записи ---------- */

export class BookingStore {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS bookings (" +
        "id TEXT PRIMARY KEY, date TEXT NOT NULL, time TEXT NOT NULL, " +
        "name TEXT NOT NULL, contact TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '', " +
        "status TEXT NOT NULL, created INTEGER NOT NULL)"
    );
    // Один слот держит только одну живую запись. Отклонённая освобождает время.
    this.sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS one_slot ON bookings(date, time) " +
        "WHERE status IN ('pending', 'confirmed')"
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/book") return await this.book(request);
      if (url.pathname === "/busy") return await this.busy(url);
      if (url.pathname === "/decide") return await this.decide(request);
      if (url.pathname === "/list") return await this.list(url);
      if (url.pathname === "/cleanup") return await this.cleanup();
      return reply({ ok: false, error: "Неизвестная операция." }, 404);
    } catch (err) {
      console.error("store failed", err && err.stack ? err.stack : err);
      return reply({ ok: false, error: "Хранилище не ответило." }, 500);
    }
  }

  async book(request) {
    const b = await request.json();
    const id = newId();

    try {
      this.sql.exec(
        "INSERT INTO bookings (id, date, time, name, contact, comment, status, created) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
        id, b.date, b.time, b.name, b.contact, b.comment || "", Date.now()
      );
    } catch (err) {
      if (String(err && err.message).includes("UNIQUE")) return reply({ ok: false, code: "taken" }, 409);
      throw err;
    }

    return reply({ ok: true, id, booking: { ...b, id, status: "pending" } });
  }

  async busy(url) {
    const from = url.searchParams.get("from") || "2000-01-01";
    const to = url.searchParams.get("to") || "2999-12-31";
    const rows = this.sql.exec(
      "SELECT date, time FROM bookings WHERE status IN ('pending', 'confirmed') " +
        "AND date >= ? AND date <= ? ORDER BY date, time",
      from, to
    );
    const busy = [];
    for (const row of rows) busy.push(row.date + " " + row.time);
    return reply({ ok: true, busy });
  }

  async decide(request) {
    const { id, decision } = await request.json();
    if (decision !== "confirmed" && decision !== "rejected") return reply({ ok: false, error: "Неизвестное решение." }, 400);

    const row = first(this.sql.exec("SELECT * FROM bookings WHERE id = ?", id));
    if (!row) return reply({ ok: false, code: "missing" }, 404);

    try {
      this.sql.exec("UPDATE bookings SET status = ? WHERE id = ?", decision, id);
    } catch (err) {
      if (String(err && err.message).includes("UNIQUE")) return reply({ ok: false, code: "taken" }, 409);
      throw err;
    }

    return reply({ ok: true, booking: { ...row, status: decision } });
  }

  async list(url) {
    const from = url.searchParams.get("from") || "2000-01-01";
    const to = url.searchParams.get("to") || "2999-12-31";
    const rows = this.sql.exec(
      "SELECT * FROM bookings WHERE status IN ('pending', 'confirmed') " +
        "AND date >= ? AND date <= ? ORDER BY date, time",
      from, to
    );
    return reply({ ok: true, bookings: [...rows] });
  }

  async cleanup() {
    const pendingCutoff = Date.now() - PENDING_TTL_MS;
    const oldDate = dayString(-KEEP_DAYS, 0);
    const pending = this.sql.exec("DELETE FROM bookings WHERE status = 'pending' AND created < ?", pendingCutoff).rowsWritten;
    const old = this.sql.exec("DELETE FROM bookings WHERE date < ?", oldDate).rowsWritten;
    return reply({ ok: true, pending, old });
  }
}

function reply(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function first(cursor) {
  for (const row of cursor) return row;
  return null;
}

function newId() {
  const rand = Math.floor(Math.random() * 46656).toString(36).padStart(3, "0");
  return Date.now().toString(36).slice(-5) + rand;
}

function store(env) {
  return env.STORE.get(env.STORE.idFromName("main"));
}

async function storeCall(env, path, options) {
  const res = await store(env).fetch("https://store" + path, options);
  return res.json();
}

/* ---------- Свободное время ---------- */

async function handleSlots(url, env) {
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 21, 1), 60);
  const tz = tzOffset(env);
  const from = dayString(0, tz);
  const to = dayString(days, tz);

  const data = await storeCall(env, "/busy?from=" + from + "&to=" + to);
  if (!data.ok) return json({ ok: false, error: "Не удалось получить занятое время." }, 502, env);
  return json({ ok: true, busy: data.busy }, 200, env);
}

/* ---------- Новая заявка ---------- */

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
  const contact = text(body.phone, 32);
  const comment = text(body.comment, 300);
  const date = text(body.date, 10);
  const time = text(body.time, 5);

  if (name.length < 2) return json({ ok: false, error: "Напишите имя." }, 400, env);
  if (!isContact(contact)) return json({ ok: false, error: "Оставьте телефон или Telegram." }, 400, env);
  if (!DATE_RE.test(date) || !isRealDate(date) || !inRange(date)) {
    return json({ ok: false, error: "Выберите корректную дату." }, 400, env);
  }
  if (!TIME_RE.test(time)) return json({ ok: false, error: "Выберите корректное время." }, 400, env);

  if (!env.BOT_TOKEN || !env.CHAT_ID) {
    console.error("BOT_TOKEN or CHAT_ID is not configured");
    return json({ ok: false, error: "Запись временно недоступна. Напишите напрямую." }, 500, env);
  }

  const created = await storeCall(env, "/book", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, contact, comment, date, time })
  });

  if (!created.ok) {
    if (created.code === "taken") {
      return json(
        { ok: false, code: "taken", error: "Это время только что заняли. Выберите другое." },
        409, env
      );
    }
    return json({ ok: false, error: "Запись временно недоступна. Напишите напрямую." }, 502, env);
  }

  const card = bookingCard({ name, contact, comment, date, time });
  const keyboard = {
    inline_keyboard: [[
      { text: "Подтвердить", callback_data: "c:" + created.id },
      { text: "Отклонить", callback_data: "x:" + created.id }
    ]]
  };

  try {
    for (const chatId of chatIds(env)) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Новая заявка\n\n" + card,
        disable_web_page_preview: true,
        reply_markup: keyboard
      });
    }
  } catch (err) {
    console.error("telegram send failed", err && err.stack ? err.stack : err);
    // Заявка не дошла до владельца. Освобождаем слот, чтобы клиент мог повторить.
    await storeCall(env, "/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: created.id, decision: "rejected" })
    });
    return json({ ok: false, error: "Не удалось отправить заявку. Попробуйте ещё раз." }, 502, env);
  }

  return json({ ok: true, id: created.id }, 200, env);
}

/* ---------- Telegram ---------- */

async function handleUpdate(request, env) {
  const expected = await secretKey(env, "webhook");
  const got = request.headers.get("x-telegram-bot-api-secret-token");
  if (got !== expected) return new Response("forbidden", { status: 403 });

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok");
  }

  try {
    if (update.callback_query) await onCallback(update.callback_query, env);
    else if (update.message && update.message.text) await onCommand(update.message, env);
  } catch (err) {
    console.error("update failed", err && err.stack ? err.stack : err);
  }

  // Telegram повторяет запрос, если ответ не 200.
  return new Response("ok");
}

async function onCallback(query, env) {
  const from = String(query.from && query.from.id || "");
  const message = query.message || {};
  const allowed = chatIds(env).includes(from) || chatIds(env).includes(String(message.chat && message.chat.id || ""));

  if (!allowed) {
    await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Это не ваша заявка." });
    return;
  }

  const data = String(query.data || "");
  const decision = data.startsWith("c:") ? "confirmed" : data.startsWith("x:") ? "rejected" : "";
  const id = data.slice(2);

  if (!decision || !id) {
    await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Кнопка устарела." });
    return;
  }

  const result = await storeCall(env, "/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, decision })
  });

  if (!result.ok) {
    const text = result.code === "missing"
      ? "Заявка удалена или устарела."
      : result.code === "taken"
        ? "Это время уже занято другой записью."
        : "Не получилось сохранить решение.";
    await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text });
    return;
  }

  const b = result.booking;
  const mark = decision === "confirmed" ? "Подтверждена" : "Отклонена";
  const card = bookingCard(b);

  if (message.message_id && message.chat) {
    await tg(env, "editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: mark + "\n\n" + card,
      disable_web_page_preview: true
    }).catch(() => {});
  }

  await tg(env, "answerCallbackQuery", {
    callback_query_id: query.id,
    text: decision === "confirmed" ? "Записал. Слот занят." : "Отклонил. Слот свободен."
  }).catch(() => {});
}

async function onCommand(message, env) {
  const from = String(message.from && message.from.id || "");
  if (!chatIds(env).includes(from)) return;

  const text = String(message.text || "").trim().split(/\s+/)[0].toLowerCase();
  const tz = tzOffset(env);

  if (text === "/start" || text === "/help") {
    await tg(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "Заявки с сайта приходят сюда. Кнопки под заявкой меняют её статус.\n\n" +
        "/today — на сегодня\n/tomorrow — на завтра\n/all — все записи"
    });
    return;
  }

  let fromDay = "";
  let toDay = "";
  let title = "";

  if (text === "/today") {
    fromDay = toDay = dayString(0, tz);
    title = "Сегодня";
  } else if (text === "/tomorrow") {
    fromDay = toDay = dayString(1, tz);
    title = "Завтра";
  } else if (text === "/all") {
    fromDay = dayString(0, tz);
    toDay = dayString(30, tz);
    title = "Ближайшие 30 дней";
  } else {
    return;
  }

  const data = await storeCall(env, "/list?from=" + fromDay + "&to=" + toDay);
  if (!data.ok) {
    await tg(env, "sendMessage", { chat_id: message.chat.id, text: "Хранилище не ответило. Попробуйте позже." });
    return;
  }

  await tg(env, "sendMessage", {
    chat_id: message.chat.id,
    text: title + "\n\n" + scheduleText(data.bookings),
    disable_web_page_preview: true
  });
}

async function runDaily(env) {
  await storeCall(env, "/cleanup", { method: "POST" }).catch(() => {});

  const tz = tzOffset(env);
  const tomorrow = dayString(1, tz);
  const data = await storeCall(env, "/list?from=" + tomorrow + "&to=" + tomorrow);
  if (!data.ok) return;

  const live = data.bookings.filter((b) => b.status === "confirmed");
  if (!live.length) return;

  const text = "Завтра, " + humanDate(tomorrow) + "\n\n" + scheduleText(live);
  for (const chatId of chatIds(env)) {
    await tg(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }).catch(() => {});
  }
}

async function handleSetup(url, env) {
  const key = (await secretKey(env, "setup")).slice(0, 32);
  if (url.searchParams.get("key") !== key) {
    return new Response("Не найдено", { status: 404 });
  }

  const out = {};
  out.webhook = await tg(env, "setWebhook", {
    url: url.origin + "/api/telegram",
    secret_token: await secretKey(env, "webhook"),
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true
  });
  out.commands = await tg(env, "setMyCommands", {
    commands: [
      { command: "today", description: "Записи на сегодня" },
      { command: "tomorrow", description: "Записи на завтра" },
      { command: "all", description: "Все записи" }
    ]
  });

  return json({ ok: true, out }, 200, env);
}

async function secretKey(env, label) {
  const data = new TextEncoder().encode(label + ":" + env.BOT_TOKEN);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function tg(env, method, payload) {
  const base = env.TELEGRAM_API_BASE || "https://api.telegram.org";
  const res = await fetch(base + "/bot" + env.BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}

  if (!res.ok || !data.ok) {
    throw new Error("Telegram " + res.status + " " + method + ": " + raw.slice(0, 300));
  }
  return data.result;
}

/* ---------- Текст ---------- */

function bookingCard(b) {
  return [
    "Имя: " + b.name,
    "Контакт: " + b.contact,
    "Когда: " + humanDate(b.date) + ", " + b.time,
    b.comment ? "Комментарий: " + b.comment : ""
  ].filter(Boolean).join("\n");
}

function scheduleText(bookings) {
  if (!bookings.length) return "Записей нет.";

  const byDate = new Map();
  for (const b of bookings) {
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date).push(b);
  }

  const lines = [];
  for (const [date, items] of byDate) {
    if (byDate.size > 1) lines.push("", humanDate(date));
    for (const b of items) {
      const tail = b.status === "confirmed" ? "" : " (ждёт ответа)";
      lines.push(b.time + " " + b.name + ", " + b.contact + tail);
    }
  }
  return lines.join("\n").trim();
}

function humanDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("ru-RU", {
    weekday: "short", day: "numeric", month: "long", timeZone: "UTC"
  }).format(date);
}

function chatIds(env) {
  return String(env.CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function tzOffset(env) {
  const value = Number(env.TZ_OFFSET_HOURS);
  return Number.isFinite(value) ? value : 3;
}

function dayString(offsetDays, tz) {
  const ms = Date.now() + tz * 3600000 + offsetDays * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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
