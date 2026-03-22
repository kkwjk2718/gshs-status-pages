import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "public", "data");
const currentPath = path.join(dataDir, "current.json");
const historyPath = path.join(dataDir, "history.json");

const historySources = (
  process.env.STATUS_HISTORY_URLS ??
  "https://status.gshs.app/data/history.json,https://kkwjk2718.github.io/gshs-status-pages/data/history.json"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "gshs-status-pages/0.1",
      "Cache-Control": "no-cache",
    },
  });

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return response.json();
}

async function loadPreviousHistory() {
  for (const url of historySources) {
    try {
      const payload = await fetchJson(url);
      if (Array.isArray(payload)) {
        return payload;
      }
    } catch {}
  }

  try {
    const local = JSON.parse(await fs.readFile(historyPath, "utf8"));
    return Array.isArray(local) ? local : [];
  } catch {
    return [];
  }
}

async function timedFetch(url, parser = async (response) => ({ body: await response.text() })) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "gshs-status-pages/0.1",
        "Cache-Control": "no-cache",
      },
    });

    const parsed = await parser(response);
    return {
      ok: response.ok,
      statusCode: response.status,
      responseTimeMs: Date.now() - startedAt,
      ...parsed,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      responseTimeMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function mapHomepageStatus(check) {
  if (check.ok) return "operational";
  return check.statusCode ? "degraded" : "outage";
}

function mapHealthStatus(check) {
  if (check.ok && check.payload?.ok === true && check.payload?.service === "gshsapp") {
    return "operational";
  }

  if (check.ok || check.statusCode) {
    return "degraded";
  }

  return "outage";
}

function mapOverallStatus(homepageStatus, healthStatus) {
  if (homepageStatus === "operational" && healthStatus === "operational") {
    return "operational";
  }

  if (homepageStatus === "outage" || healthStatus === "outage") {
    return "outage";
  }

  return "degraded";
}

function buildSummary(overallStatus, version) {
  if (overallStatus === "operational") {
    return version ? `서비스가 정상 응답 중이며 현재 버전은 ${version}입니다.` : "서비스가 정상 응답 중입니다.";
  }

  if (overallStatus === "degraded") {
    return "일부 점검 항목이 비정상 응답을 반환했습니다. 운영자가 확인 중일 수 있습니다.";
  }

  return "메인 서비스 또는 헬스 체크 응답에 장애가 감지되었습니다.";
}

const homepageCheck = await timedFetch("https://gshs.app/");
const healthCheck = await timedFetch("https://gshs.app/api/health", async (response) => {
  const text = await response.text();

  try {
    return {
      body: text,
      payload: JSON.parse(text),
    };
  } catch {
    return {
      body: text,
      payload: null,
    };
  }
});

const homepageStatus = mapHomepageStatus(homepageCheck);
const healthStatus = mapHealthStatus(healthCheck);
const overallStatus = mapOverallStatus(homepageStatus, healthStatus);
const version = healthCheck.payload?.version ?? null;
const generatedAt = new Date().toISOString();
const history = await loadPreviousHistory();

const nextHistory = [
  ...history,
  {
    timestamp: generatedAt,
    overallStatus,
    homepageStatus,
    healthStatus,
    version,
  },
].filter((entry) => {
  const timestamp = Date.parse(entry.timestamp);
  return Number.isFinite(timestamp) && timestamp >= Date.now() - 30 * 24 * 60 * 60 * 1000;
});

const current = {
  generatedAt,
  overallStatus,
  summary: buildSummary(overallStatus, version),
  version,
  homepage: {
    status: homepageStatus,
    statusCode: homepageCheck.statusCode,
    responseTimeMs: homepageCheck.responseTimeMs,
  },
  health: {
    status: healthStatus,
    statusCode: healthCheck.statusCode,
    responseTimeMs: healthCheck.responseTimeMs,
    ok: healthCheck.payload?.ok ?? null,
    service: healthCheck.payload?.service ?? null,
    version,
  },
};

await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(currentPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
await fs.writeFile(historyPath, `${JSON.stringify(nextHistory, null, 2)}\n`, "utf8");

console.log(`Updated status data: ${overallStatus}${version ? ` (${version})` : ""}`);
