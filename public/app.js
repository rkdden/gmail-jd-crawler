// 서버의 상태 정규화 목록과 동일하게 유지해야 필터와 배지 색상이 일관된다.
const UNKNOWN = "알수없음";
const NONE = "없음";
const STATUSES = Object.freeze(["지원완료", "서류합격", "면접진행", "최종합격", "불합격", UNKNOWN]);

// 화면 상태는 URL이나 저장소에 의존하지 않는 순수 데이터로만 관리한다.
const state = {
  applications: [],
  search: "",
  status: "all",
  sort: "evidenceEmailReceivedAt:desc"
};

function getElement(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`${selector} 요소를 찾지 못했습니다.`);
  }
  return element;
}

const elements = {
  summary: getElement("#summary"),
  searchInput: getElement("#searchInput"),
  statusFilter: getElement("#statusFilter"),
  sortSelect: getElement("#sortSelect"),
  body: getElement("#applicationsBody"),
  emptyState: getElement("#emptyState")
};

function statusClass(status) {
  return `status-${(normalizeText(status) || UNKNOWN).replaceAll(" ", "-")}`;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function parseDateValue(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getSortedRows(rows) {
  const [field, direction] = state.sort.split(":");
  const factor = direction === "asc" ? 1 : -1;
  return rows.toSorted((a, b) => {
    const left = field === "appliedAt" ? parseDateValue(a.appliedAt) : parseDateValue(a.evidenceEmailReceivedAt);
    const right = field === "appliedAt" ? parseDateValue(b.appliedAt) : parseDateValue(b.evidenceEmailReceivedAt);
    return (left - right) * factor;
  });
}

function getFilteredRows() {
  const keyword = state.search.toLowerCase();
  return state.applications.filter((item) => {
    const matchesStatus = state.status === "all" || item.status === state.status;
    const target = `${item.companyName ?? ""} ${item.position ?? ""}`.toLowerCase();
    return matchesStatus && target.includes(keyword);
  });
}

function createCell(text) {
  const cell = document.createElement("td");
  cell.textContent = normalizeText(text) || UNKNOWN;
  return cell;
}

function createStatusCell(status) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `status ${statusClass(status)}`;
  badge.textContent = normalizeText(status) || UNKNOWN;
  cell.append(badge);
  return cell;
}

function createLinkCell(url) {
  const cell = document.createElement("td");
  const normalized = normalizeText(url);
  if (!normalized || normalized === NONE) {
    cell.textContent = NONE;
    return cell;
  }

  const anchor = document.createElement("a");
  anchor.href = normalized;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.textContent = "열기";
  cell.append(anchor);
  return cell;
}

function render() {
  const rows = getSortedRows(getFilteredRows());
  elements.body.replaceChildren();

  // 이메일 제목과 링크가 외부 입력이므로 innerHTML 대신 DOM 노드와 textContent로만 렌더링한다.
  for (const item of rows) {
    const tr = document.createElement("tr");
    tr.append(
      createCell(item.companyName),
      createCell(item.position),
      createLinkCell(item.jobPostingUrl),
      createCell(item.platform),
      createCell(item.appliedAt),
      createStatusCell(item.status),
      createCell(item.evidenceEmailSubject),
      createCell(item.evidenceEmailReceivedAt)
    );
    elements.body.append(tr);
  }

  elements.emptyState.hidden = rows.length > 0;
  elements.summary.textContent = `${rows.length} / ${state.applications.length}건`;
}

function populateStatusFilter() {
  const options = STATUSES.map((status) => {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    return option;
  });
  elements.statusFilter.append(...options);
}

async function loadApplications() {
  // 매 실행마다 갱신되는 JSON이라 브라우저 캐시를 우회한다.
  const response = await fetch("/data/applications.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`applications.json 요청 실패: ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("applications.json은 JSON 배열이어야 합니다.");
  }

  state.applications = data;
  populateStatusFilter();
  render();
}

elements.searchInput.addEventListener("input", (event) => {
  state.search = event.target.value;
  render();
});

elements.statusFilter.addEventListener("change", (event) => {
  state.status = event.target.value;
  render();
});

elements.sortSelect.addEventListener("change", (event) => {
  state.sort = event.target.value;
  render();
});

loadApplications().catch((error) => {
  elements.summary.textContent = "데이터를 불러오지 못했습니다.";
  elements.emptyState.hidden = false;
  elements.emptyState.textContent = error.message;
});
