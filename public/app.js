const STATUSES = ["지원완료", "서류합격", "면접진행", "최종합격", "불합격", "알수없음"];

const state = {
  applications: [],
  search: "",
  status: "all",
  sort: "evidenceEmailReceivedAt:desc"
};

const elements = {
  summary: document.querySelector("#summary"),
  searchInput: document.querySelector("#searchInput"),
  statusFilter: document.querySelector("#statusFilter"),
  sortSelect: document.querySelector("#sortSelect"),
  body: document.querySelector("#applicationsBody"),
  emptyState: document.querySelector("#emptyState")
};

function statusClass(status) {
  return `status-${String(status || "알수없음").replaceAll(" ", "-")}`;
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
  return [...rows].sort((a, b) => {
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
  cell.textContent = normalizeText(text) || "알수없음";
  return cell;
}

function createLinkCell(url) {
  const cell = document.createElement("td");
  const normalized = normalizeText(url);
  if (!normalized || normalized === "없음") {
    cell.textContent = "없음";
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

  for (const item of rows) {
    const tr = document.createElement("tr");
    tr.append(
      createCell(item.companyName),
      createCell(item.position),
      createLinkCell(item.jobPostingUrl),
      createCell(item.platform),
      createCell(item.appliedAt),
      createCell(item.status),
      createCell(item.evidenceEmailSubject),
      createCell(item.evidenceEmailReceivedAt)
    );
    tr.children[5].replaceChildren();
    const badge = document.createElement("span");
    badge.className = `status ${statusClass(item.status)}`;
    badge.textContent = normalizeText(item.status) || "알수없음";
    tr.children[5].append(badge);
    elements.body.append(tr);
  }

  elements.emptyState.hidden = rows.length > 0;
  elements.summary.textContent = `${rows.length} / ${state.applications.length}건`;
}

function populateStatusFilter() {
  for (const status of STATUSES) {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    elements.statusFilter.append(option);
  }
}

async function loadApplications() {
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
