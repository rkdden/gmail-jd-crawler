import "dotenv/config";

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.dirname(__filename);

// 실행 중 읽고 쓰는 경로를 한 곳에 모아 두면 CLI, 웹서버, 테스트가 같은 파일을 바라본다.
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const TMP_DIR = path.join(ROOT_DIR, "tmp");
const EMAILS_TMP_PATH = path.join(TMP_DIR, "emails.json");
const CODEX_RESULT_PATH = path.join(TMP_DIR, "codex-result.json");
const APPLICATIONS_PATH = path.join(DATA_DIR, "applications.json");
const LEA_PATH = path.join(ROOT_DIR, "LEA.md");

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const UNKNOWN = "알수없음";
const NONE = "없음";
const VALID_STATUSES = new Set(["지원완료", "서류합격", "면접진행", "최종합격", "불합격", UNKNOWN]);

// Gmail 검색은 넓게 가져온 뒤, 수신일과 본문 분석 단계에서 한 번 더 걸러낸다.
const KEYWORDS = [
  "채용",
  "지원",
  "서류",
  "면접",
  "합격",
  "불합격",
  "결과",
  "입사지원",
  "채용공고",
  "사람인",
  "원티드",
  "리멤버",
  "잡코리아"
];

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
]);

/**
 * @typedef {object} ParsedEmail
 * @property {string} id
 * @property {string} threadId
 * @property {string} subject
 * @property {string} from
 * @property {string} receivedAt
 * @property {string[]} links
 * @property {string} body
 */

/**
 * @typedef {object} Application
 * @property {string} companyName
 * @property {string} position
 * @property {string} jobPostingUrl
 * @property {string} platform
 * @property {string} appliedAt
 * @property {string} status
 * @property {string} evidenceEmailSubject
 * @property {string} evidenceEmailReceivedAt
 */

function relativePath(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function sixMonthsAgo(from = new Date()) {
  const date = new Date(from);
  date.setMonth(date.getMonth() - 6);
  return date;
}

function partsInSeoul(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatSeoulIso(date) {
  const parts = partsInSeoul(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
}

function formatSeoulDate(date) {
  const parts = partsInSeoul(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatGmailDate(date) {
  const parts = partsInSeoul(date);
  return `${parts.year}/${parts.month}/${parts.day}`;
}

function parseDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDateOnly(value) {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = parseDateOrNull(text);
  return date ? formatSeoulDate(date) : "";
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function errorMessage(error) {
  if (error?.response?.data?.error_description) return error.response.data.error_description;
  if (error?.response?.data?.error) return JSON.stringify(error.response.data.error);
  if (error?.errors?.length) return error.errors.map((item) => item.message).join("; ");
  return error?.message ?? String(error);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureRuntimeFiles() {
  await Promise.all([
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(PUBLIC_DIR, { recursive: true }),
    fs.mkdir(TMP_DIR, { recursive: true })
  ]);

  if (!(await pathExists(APPLICATIONS_PATH))) {
    await fs.writeFile(APPLICATIONS_PATH, "[]\n", "utf8");
  }

  if (!(await pathExists(LEA_PATH))) {
    await fs.writeFile(LEA_PATH, "# Last Email Access\n\nlast_email_accessed_at:\n", "utf8");
  }
}

export async function readLastEmailAccess() {
  await ensureRuntimeFiles();
  const fallback = sixMonthsAgo();

  try {
    const content = await fs.readFile(LEA_PATH, "utf8");
    const match = content.match(/^last_email_accessed_at:\s*(.+?)\s*$/m);
    const parsed = parseDateOrNull(match?.[1]);

    if (!parsed) {
      return {
        since: fallback,
        usedFallback: true,
        reason: "LEA.md의 last_email_accessed_at 값이 없거나 파싱에 실패했습니다."
      };
    }

    return { since: parsed, usedFallback: false, reason: "" };
  } catch (error) {
    return {
      since: fallback,
      usedFallback: true,
      reason: `LEA.md를 읽지 못했습니다: ${errorMessage(error)}`
    };
  }
}

export async function updateLastEmailAccess(date) {
  const content = `# Last Email Access\n\nlast_email_accessed_at: ${formatSeoulIso(date)}\n`;
  await fs.writeFile(LEA_PATH, content, "utf8");
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`.env에 ${name} 값을 설정해야 합니다.`);
  }
  return value;
}

function extractOAuthCode(inputValue) {
  const raw = inputValue.trim();
  if (!URL.canParse(raw)) {
    return raw;
  }

  const url = new URL(raw);
  return url.searchParams.get("code") || raw;
}

async function requestInitialToken(oauth2Client, tokenPath) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES
  });

  console.log("\nGmail OAuth 인증 URL:");
  console.log(authUrl);
  console.log("\n브라우저에서 인증한 뒤 리디렉션 URL의 code 값을 입력하세요.");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("인증 코드: ");
  rl.close();

  try {
    const { tokens } = await oauth2Client.getToken(extractOAuthCode(answer));
    oauth2Client.setCredentials(tokens);
    await fs.mkdir(path.dirname(tokenPath), { recursive: true });
    await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2), "utf8");
    console.log(`토큰 저장 완료: ${relativePath(tokenPath)}`);
  } catch (error) {
    throw new Error(`Gmail 인증 실패: ${errorMessage(error)}`);
  }
}

export async function createOAuthClient() {
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const redirectUri = requireEnv("GOOGLE_REDIRECT_URI");
  const tokenPath = path.resolve(ROOT_DIR, process.env.GOOGLE_TOKEN_PATH || "token.json");
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  if (await pathExists(tokenPath)) {
    try {
      const tokens = JSON.parse(await fs.readFile(tokenPath, "utf8"));
      oauth2Client.setCredentials(tokens);
      return oauth2Client;
    } catch (error) {
      throw new Error(`저장된 Gmail 토큰을 읽지 못했습니다: ${errorMessage(error)}`);
    }
  }

  await requestInitialToken(oauth2Client, tokenPath);
  return oauth2Client;
}

function buildGmailQuery(sinceDate) {
  const keywordQuery = KEYWORDS.join(" OR ");
  return `after:${formatGmailDate(sinceDate)} (${keywordQuery})`;
}

function decodeBase64Url(data) {
  return Buffer.from(data.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
}

// Gmail API는 plain/html 본문과 첨부 메타데이터를 parts 안에 중첩해서 내려줄 수 있다.
function collectBodyParts(payload, parts = []) {
  if (!payload) return parts;

  if (payload.body?.data) {
    parts.push({
      mimeType: payload.mimeType ?? "",
      content: decodeBase64Url(payload.body.data)
    });
  }

  for (const child of payload.parts ?? []) {
    collectBodyParts(child, parts);
  }

  return parts;
}

function decodeHtmlEntities(text) {
  return text
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function stripHtml(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/tr)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
  ).trim();
}

function extractLinks(text) {
  const links = new Set();
  const source = String(text ?? "");

  for (const match of source.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    links.add(match[0].replace(/[.,;:!?]+$/g, ""));
  }

  for (const match of source.matchAll(/\bhref=["']([^"']+)["']/gi)) {
    if (/^https?:\/\//i.test(match[1])) {
      links.add(match[1].replace(/[.,;:!?]+$/g, ""));
    }
  }

  return [...links];
}

function headersToMap(headers = []) {
  return new Map(headers.map((header) => [String(header.name ?? "").toLowerCase(), header.value ?? ""]));
}

/**
 * Gmail 원본 메시지를 Codex 분석에 넘기기 쉬운 얇은 이메일 객체로 정규화한다.
 *
 * @param {import("googleapis").gmail_v1.Schema$Message} message
 * @returns {ParsedEmail}
 */
function parseGmailMessage(message) {
  const payload = message.payload ?? {};
  const headers = headersToMap(payload.headers);
  const parts = collectBodyParts(payload);
  const plainBody = parts
    .filter((part) => part.mimeType.startsWith("text/plain"))
    .map((part) => part.content)
    .join("\n")
    .trim();
  const htmlBody = parts
    .filter((part) => part.mimeType.startsWith("text/html"))
    .map((part) => part.content)
    .join("\n")
    .trim();
  const body = (plainBody || stripHtml(htmlBody)).replace(/\r/g, "").trim();
  const receivedDate = message.internalDate
    ? new Date(Number(message.internalDate))
    : parseDateOrNull(headers.get("date")) ?? new Date();

  return {
    id: message.id,
    threadId: message.threadId,
    subject: headers.get("subject") || "(제목 없음)",
    from: headers.get("from") || UNKNOWN,
    receivedAt: formatSeoulIso(receivedDate),
    links: [...new Set([...extractLinks(plainBody), ...extractLinks(htmlBody)])],
    body
  };
}

export async function fetchGmailEmails(gmail, sinceDate) {
  const query = buildGmailQuery(sinceDate);
  const messageRefs = [];
  let pageToken;

  console.log(`Gmail 검색 쿼리: ${query}`);

  try {
    // Gmail 검색어는 날짜 단위라, 이후 루프에서 정확한 시각 기준으로 다시 필터링한다.
    do {
      const response = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 100,
        pageToken
      });

      messageRefs.push(...(response.data.messages ?? []));
      pageToken = response.data.nextPageToken;
    } while (pageToken);
  } catch (error) {
    throw new Error(`Gmail 조회 실패: ${errorMessage(error)}`);
  }

  console.log(`Gmail 검색 결과: ${messageRefs.length}개 메시지`);

  const emails = [];
  for (const ref of messageRefs) {
    try {
      const response = await gmail.users.messages.get({
        userId: "me",
        id: ref.id,
        format: "full"
      });
      const email = parseGmailMessage(response.data);
      const receivedDate = parseDateOrNull(email.receivedAt);
      if (receivedDate && receivedDate > sinceDate) {
        emails.push(email);
      }
    } catch (error) {
      console.error(`이메일 ${ref.id} 조회 실패: ${errorMessage(error)}`);
    }
  }

  return emails.toSorted(
    (a, b) => (parseDateOrNull(a.receivedAt)?.getTime() ?? 0) - (parseDateOrNull(b.receivedAt)?.getTime() ?? 0)
  );
}

export async function saveFetchedEmails(emails) {
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.writeFile(EMAILS_TMP_PATH, `${JSON.stringify(emails, null, 2)}\n`, "utf8");
  return EMAILS_TMP_PATH;
}

function parseArgString(value) {
  const args = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

function codexArgs() {
  const configured = process.env.CODEX_EXEC_ARGS?.trim();
  if (configured) {
    // 환경변수에 따옴표가 포함될 수 있어 shell 없이 사용할 인자 배열로 직접 분해한다.
    return parseArgString(configured).map((arg) => (arg === "." ? ROOT_DIR : arg));
  }

  return [
    "--ask-for-approval",
    "never",
    "exec",
    "--sandbox",
    "workspace-write",
    "-C",
    ROOT_DIR,
    "--skip-git-repo-check"
  ];
}

function runChildProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // shell을 거치지 않고 인자 배열로 실행해 공백/따옴표가 포함된 경로를 안전하게 넘긴다.
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function assertCodexInstalled(command) {
  try {
    const result = await runChildProcess(command, ["--version"]);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `exit code ${result.code}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Codex CLI가 설치되어 있지 않습니다. codex 명령을 설치하거나 CODEX_COMMAND를 설정하세요.");
    }
    throw new Error(`Codex CLI 확인 실패: ${errorMessage(error)}`);
  }
}

function buildCodexPrompt(emailPath, resultPath) {
  // Codex가 분석 결과 파일 하나만 쓰도록 입력/출력 경로와 JSON 스키마를 명확히 제한한다.
  return [
    "tmp/emails.json 파일을 읽어 채용 지원 이력만 추출하세요.",
    "",
    `입력 파일: ${relativePath(emailPath)}`,
    `출력 파일: ${relativePath(resultPath)}`,
    "",
    "수행할 작업:",
    "- 각 이메일의 제목, 본문, 발신자, 수신일, 링크를 분석한다.",
    "- 채용 지원 이력만 추출한다.",
    "- 기업명, 직무명, 채용공고 링크, 플랫폼명, 지원 날짜, 상태, 근거 이메일 제목, 근거 이메일 수신일을 추출한다.",
    "- 결과는 JSON 배열로만 작성한다.",
    "- 설명 문장 없이 순수 JSON만 tmp/codex-result.json에 저장한다.",
    "- 상태는 지원완료, 서류합격, 면접진행, 최종합격, 불합격, 알수없음 중 하나만 사용한다.",
    "- 같은 기업이라도 직무명 또는 지원 날짜가 다르면 별도 항목으로 분리한다.",
    "- 같은 기업, 같은 직무, 같은 지원 날짜면 하나의 항목만 남기고 최신 이메일 기준으로 상태와 근거를 업데이트한다.",
    "- 기업명, 직무명, 플랫폼명이 불명확하면 알수없음으로 저장한다.",
    "- 채용공고 링크가 없으면 없음으로 저장한다.",
    "- 지원 날짜가 불명확하면 이메일 수신일의 날짜를 사용한다.",
    "- 판단이 어려운 값은 임의로 만들지 말고 알수없음 또는 없음으로 저장한다.",
    "- tmp/codex-result.json 외의 파일은 수정하지 않는다.",
    "",
    "각 항목은 반드시 다음 키를 가진다:",
    "companyName, position, jobPostingUrl, platform, appliedAt, status, evidenceEmailSubject, evidenceEmailReceivedAt"
  ].join("\n");
}

export async function runCodexAnalysis(emailPath = EMAILS_TMP_PATH, resultPath = CODEX_RESULT_PATH) {
  const command = process.env.CODEX_COMMAND?.trim() || "codex";
  await assertCodexInstalled(command);
  await fs.rm(resultPath, { force: true });

  const args = [...codexArgs(), buildCodexPrompt(emailPath, resultPath)];
  const result = await runChildProcess(command, args);
  if (result.code !== 0) {
    throw new Error(`Codex CLI 실행 실패:\n${result.stderr || result.stdout || `exit code ${result.code}`}`);
  }

  try {
    const content = await fs.readFile(resultPath, "utf8");
    const applications = JSON.parse(content);
    if (!Array.isArray(applications)) {
      throw new Error("분석 결과가 JSON 배열이 아닙니다.");
    }
    return applications;
  } catch (error) {
    throw new Error(`Codex 분석 결과 파일을 읽지 못했습니다 (${relativePath(resultPath)}): ${errorMessage(error)}`);
  }
}

async function readJsonArray(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Codex 결과와 기존 저장 데이터를 같은 형태로 맞춘다.
 *
 * @param {Partial<Application>} raw
 * @returns {Application}
 */
function normalizeApplication(raw) {
  const evidenceDate = cleanString(raw.evidenceEmailReceivedAt);
  const appliedAt = normalizeDateOnly(raw.appliedAt) || normalizeDateOnly(evidenceDate) || UNKNOWN;
  const status = VALID_STATUSES.has(cleanString(raw.status)) ? cleanString(raw.status) : UNKNOWN;

  return {
    companyName: cleanString(raw.companyName) || UNKNOWN,
    position: cleanString(raw.position) || UNKNOWN,
    jobPostingUrl: cleanString(raw.jobPostingUrl) || NONE,
    platform: cleanString(raw.platform) || UNKNOWN,
    appliedAt,
    status,
    evidenceEmailSubject: cleanString(raw.evidenceEmailSubject) || UNKNOWN,
    evidenceEmailReceivedAt: evidenceDate || UNKNOWN
  };
}

function applicationKey(application) {
  // 같은 회사라도 직무명 또는 지원일이 다르면 별도 지원 이력으로 보존한다.
  return [application.companyName, application.position, application.appliedAt]
    .map((value) => String(value).trim().toLowerCase())
    .join("|");
}

function evidenceTime(application) {
  return parseDateOrNull(application.evidenceEmailReceivedAt)?.getTime() ?? 0;
}

function mergeKnownFields(existing, incoming) {
  // 최신 근거 이메일을 우선하되, 새 값이 불명확하면 기존에 알던 값을 유지한다.
  return {
    companyName: incoming.companyName !== UNKNOWN ? incoming.companyName : existing.companyName,
    position: incoming.position !== UNKNOWN ? incoming.position : existing.position,
    jobPostingUrl: incoming.jobPostingUrl !== NONE ? incoming.jobPostingUrl : existing.jobPostingUrl || NONE,
    platform: incoming.platform !== UNKNOWN ? incoming.platform : existing.platform || UNKNOWN,
    appliedAt: incoming.appliedAt !== UNKNOWN ? incoming.appliedAt : existing.appliedAt,
    status: incoming.status,
    evidenceEmailSubject: incoming.evidenceEmailSubject,
    evidenceEmailReceivedAt: incoming.evidenceEmailReceivedAt
  };
}

function upsertApplication(map, application) {
  const key = applicationKey(application);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, application);
    return;
  }

  if (evidenceTime(application) >= evidenceTime(existing)) {
    map.set(key, mergeKnownFields(existing, application));
  }
}

export async function mergeAndSaveApplications(newApplications) {
  const merged = new Map();
  const existingApplications = await readJsonArray(APPLICATIONS_PATH);

  for (const application of existingApplications.map(normalizeApplication)) {
    upsertApplication(merged, application);
  }

  for (const application of newApplications.map(normalizeApplication)) {
    upsertApplication(merged, application);
  }

  const rows = [...merged.values()].toSorted((a, b) => {
    const evidenceDelta = evidenceTime(b) - evidenceTime(a);
    if (evidenceDelta) return evidenceDelta;
    return String(b.appliedAt).localeCompare(String(a.appliedAt));
  });

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(APPLICATIONS_PATH, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new Error(`applications.json 저장 실패: ${errorMessage(error)}`);
  }

  return rows;
}

function newestEmailDate(emails) {
  const newest = emails
    .map((email) => parseDateOrNull(email.receivedAt))
    .filter(Boolean)
    .toSorted((a, b) => b - a)
    .at(0);
  return newest ?? new Date();
}

function fileForRequest(requestUrl) {
  const url = new URL(requestUrl, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  // 정적 서버는 필요한 파일만 allowlist로 제공해 임의 경로 접근을 막는다.
  if (pathname === "/") return path.join(PUBLIC_DIR, "index.html");
  if (pathname === "/data/applications.json") return APPLICATIONS_PATH;
  if (pathname === "/app.js") return path.join(PUBLIC_DIR, "app.js");
  if (pathname === "/style.css") return path.join(PUBLIC_DIR, "style.css");
  return null;
}

export async function startServer(port = 3000) {
  // 외부 프레임워크 없이 필요한 정적 파일만 제공하는 작은 로컬 서버다.
  const server = createServer(async (req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    const filePath = fileForRequest(req.url ?? "/");
    if (!filePath) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    try {
      const content = await fs.readFile(filePath);
      const contentType = MIME_TYPES.get(path.extname(filePath)) ?? "application/octet-stream";
      res.writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-store"
      });
      res.end(content);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`포트 ${port}이 이미 사용 중입니다. PORT 값을 변경하거나 기존 프로세스를 종료하세요.`));
        return;
      }
      reject(error);
    });

    server.listen(port, "localhost", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`웹서버 실행 중: http://localhost:${actualPort}`);
      resolve(server);
    });
  });
}

export async function main() {
  // 파이프라인 순서: 기준시각 확인 -> Gmail 수집 -> Codex 분석 -> JSON 병합 -> 웹서버 시작.
  await ensureRuntimeFiles();
  const access = await readLastEmailAccess();
  if (access.usedFallback) {
    console.warn(`${access.reason} 최근 6개월 기준으로 조회합니다.`);
  }

  const auth = await createOAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const emails = await fetchGmailEmails(gmail, access.since);
  const emailPath = await saveFetchedEmails(emails);
  console.log(`${emails.length}개 이메일을 ${relativePath(emailPath)}에 저장했습니다.`);

  const codexApplications = await runCodexAnalysis(emailPath, CODEX_RESULT_PATH);
  const mergedApplications = await mergeAndSaveApplications(codexApplications);
  console.log(`${codexApplications.length}개 분석 결과를 병합했습니다. 전체 ${mergedApplications.length}건.`);

  const server = await startServer(Number(process.env.PORT || 3000));
  try {
    await updateLastEmailAccess(newestEmailDate(emails));
  } catch (error) {
    server.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
