// Тонкий прокси к Cloudflare Worker. Нужен только как второй адрес на случай,
// если сеть клиента не пускает workers.dev. Логика и хранилище живут в Worker,
// поэтому занятое время и статусы одинаковы с любого адреса.

const ALLOWED = new Set(["/api/book", "/api/slots"]);

export default async function handler(request) {
  const url = new URL(request.url);

  if (!ALLOWED.has(url.pathname)) {
    return json({ ok: false, error: "Не найдено." }, 404);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  const origin = getEnv("API_ORIGIN");
  if (!origin) {
    console.error("API_ORIGIN is not set");
    return json({ ok: false, error: "Запись временно недоступна." }, 500);
  }

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  const headers = { "content-type": request.headers.get("content-type") || "application/json" };

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(origin + url.pathname + url.search, {
        method: request.method,
        headers,
        body,
        signal: AbortSignal.timeout(8000)
      });

      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") || "application/json; charset=utf-8",
          "cache-control": "no-store",
          ...cors()
        }
      });
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.error("proxy failed", lastError && lastError.message);
  return json({ ok: false, error: "Сервер не ответил. Попробуйте ещё раз." }, 502);
}

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  };
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors() }
  });
}

function getEnv(name) {
  if (typeof process !== "undefined" && process.env && process.env[name]) return process.env[name];
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name);
  } catch {}
  return "";
}
