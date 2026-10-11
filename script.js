const STORAGE_KEY = "ecoCountHistoryV2";
const GEMINI_CACHE_KEY = "ecoCountGeminiCacheV3";
const VERIFY_API_URL = "https://eco-count-api.vercel.app/api/verify";
const GEMINI_CACHE_DAYS = 30;
const MODEL_NAME = "gemini-3.5-flash-lite";

let knowledge = null;
let searchIndex = { confirmed: [], assumable: [], nonplastic: [] };
let history = loadHistory();
let knowledgeReady = null;
let currentCandidate = null;
let selectedPhoto = null;
let editingId = null;
let showAllHistory = false;
let toastTimer = null;

const $ = id => document.getElementById(id);
const els = {
  form: $("checkForm"), input: $("itemInput"), button: $("checkButton"), countPill: $("countPill"),
  result: $("result"), expression: $("expression"), resultLabel: $("resultLabel"), resultTitle: $("resultTitle"),
  resultSub: $("resultSub"), resultText: $("resultText"), resultGrid: $("resultGrid"), resultMaterial: $("resultMaterial"),
  resultWhy: $("resultWhy"), resultSource: $("resultSource"), sourcesBox: $("sourcesBox"), dismiss: $("dismissButton"),
  history: $("history"), clearHistory: $("clearHistoryMenu"), historySearch: $("historySearch"), viewAll: $("viewAllButton"),
  cameraButton: $("cameraButton"), cameraInput: $("cameraInput"), photoPreview: $("photoPreview"), previewImage: $("previewImage"),
  previewName: $("previewName"), removePhoto: $("removePhoto"), quantityInput: $("quantityInput"), addRow: $("addRow"),
  addToHistory: $("addToHistory"), addedMessage: $("addedMessage"), weekCount: $("weekCount"), weekCompare: $("weekCompare"),
  uniqueCount: $("uniqueCount"), topItem: $("topItem"), topItemCount: $("topItemCount"), weeklyChart: $("weeklyChart"),
  chartFoot: $("chartFoot"), recommendationTitle: $("recommendationTitle"), recommendationText: $("recommendationText"),
  recommendationAction: $("recommendationAction"), menuToggle: $("menuToggle"), siteMenu: $("siteMenu"), backupInput: $("backupInput"),
  exportCsv: $("exportCsv"), backupJson: $("backupJson"), importBackup: $("importBackup"), toast: $("toast"),
  editDialog: $("editDialog"), editForm: $("editForm"), editItemInput: $("editItemInput"), editQuantityInput: $("editQuantityInput"),
  closeEdit: $("closeEdit"), cancelEdit: $("cancelEdit")
};

function normalize(value) {
  return String(value ?? "").toLowerCase().trim().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ");
}
function titleCase(value) {
  return String(value || "").replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function safeQuantity(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(999, Math.max(1, parsed)) : 1;
}
function normalizeRecord(entry, index = 0) {
  if (!entry || typeof entry !== "object" || !String(entry.item || "").trim()) return null;
  const date = new Date(entry.timestamp || Date.now());
  return {
    id: String(entry.id || `${date.getTime()}-${index}-${Math.random().toString(36).slice(2, 8)}`),
    item: String(entry.item).trim().slice(0, 120),
    quantity: safeQuantity(entry.quantity ?? 1),
    status: String(entry.status || "Plastic"),
    type: String(entry.type || "Plastic type not identified"),
    code: entry.code ?? null,
    source: String(entry.source || "Local knowledge base"),
    timestamp: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
  };
}
function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeRecord).filter(Boolean).slice(0, 10000) : [];
  } catch {
    return [];
  }
}
function saveHistory() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    return true;
  } catch (error) {
    console.error("Could not save Eco Count history", error);
    showToast("Your browser could not save this change. Check available storage space.");
    return false;
  }
}
function totalCount(entries = history) {
  return entries.reduce((sum, entry) => sum + safeQuantity(entry.quantity), 0);
}
function loadGeminiCache() {
  try {
    const value = JSON.parse(localStorage.getItem(GEMINI_CACHE_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}
function saveGeminiCache(cache) {
  try { localStorage.setItem(GEMINI_CACHE_KEY, JSON.stringify(cache)); } catch (error) { console.warn("Could not save classification cache", error); }
}
function getCachedVerification(raw) {
  const cache = loadGeminiCache();
  const key = normalize(raw);
  const item = cache[key];
  if (!item) return null;
  const age = Date.now() - Number(item.timestamp || 0);
  const maxAge = GEMINI_CACHE_DAYS * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(age) || age < 0 || age > maxAge) {
    delete cache[key]; saveGeminiCache(cache); return null;
  }
  return item.result || null;
}
function cacheVerification(raw, result) {
  const cache = loadGeminiCache();
  cache[normalize(raw)] = { timestamp: Date.now(), result };
  const keys = Object.keys(cache);
  if (keys.length > 250) keys.sort((a, b) => Number(cache[a].timestamp || 0) - Number(cache[b].timestamp || 0)).slice(0, keys.length - 250).forEach(key => delete cache[key]);
  saveGeminiCache(cache);
}
function isBackendConfigured() {
  return Boolean(VERIFY_API_URL && !VERIFY_API_URL.includes("YOUR-VERCEL-PROJECT.vercel.app"));
}
async function loadKnowledge() {
  try {
    const response = await fetch("plastic.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`plastic.json returned ${response.status}`);
    knowledge = await response.json();
    searchIndex = buildSearchIndex();
  } catch (error) {
    console.error(error);
    knowledge = null;
    searchIndex = { confirmed: [], assumable: [], nonplastic: [] };
  }
}
function buildSearchIndex() {
  if (!knowledge) return { confirmed: [], assumable: [], nonplastic: [] };
  const make = list => list.flatMap(entry => [
    { entry, text: normalize(entry.item) },
    ...(entry.aliases || []).map(alias => ({ entry, text: normalize(alias) }))
  ]);
  return { confirmed: make(knowledge.confirmed_plastic || []), assumable: make(knowledge.assumeable_plastic || []), nonplastic: make(knowledge.cannot_be_plastic || []) };
}
function localMatch(raw) {
  const text = normalize(raw);
  if (!text) return { type: "empty" };
  const groups = [["confirmed", searchIndex.confirmed], ["nonplastic", searchIndex.nonplastic], ["assumable", searchIndex.assumable]];
  for (const [groupName, group] of groups) {
    const exact = group.filter(x => x.text === text).sort((a, b) => b.text.length - a.text.length)[0];
    if (exact) return { type: groupName === "nonplastic" ? "nonplastic" : groupName === "assumable" ? "assumable" : "confirmed", entry: exact.entry };
  }
  for (const [groupName, group] of groups) {
    const found = group.filter(x => x.text && text.includes(x.text)).sort((a, b) => b.text.length - a.text.length)[0];
    if (found) return { type: groupName === "nonplastic" ? "nonplastic" : groupName === "assumable" ? "assumable" : "confirmed", entry: found.entry };
  }
  return null;
}
function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
}
function showBaseResult({ expression = "✓", label, title, sub = "", text = "", material = "", why = "", source = "", sourceLinks = [], canAdd = false, grid = true, candidate = null }) {
  currentCandidate = candidate;
  els.result.hidden = false;
  els.expression.textContent = expression;
  els.resultLabel.textContent = label || "ITEM CHECKED";
  els.resultTitle.textContent = title || "Item checked";
  els.resultSub.textContent = sub;
  els.resultText.textContent = text;
  els.resultGrid.hidden = !grid;
  els.resultMaterial.textContent = material;
  els.resultWhy.textContent = why;
  els.resultSource.textContent = source;
  els.sourcesBox.innerHTML = sourceLinks.length ? sourceLinks.map(link => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.title || "Open source")}</a>`).join("") : "";
  els.addRow.hidden = !canAdd;
  els.addedMessage.hidden = true;
  els.addToHistory.disabled = false;
  els.addToHistory.innerHTML = 'Add to history <span aria-hidden="true">→</span>';
  if (canAdd) els.quantityInput.value = "1";
  els.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function candidateFrom(raw, result) {
  return { item: String(raw || "Scanned plastic item").trim().slice(0, 120), status: result.status || "Plastic", type: result.type || "Plastic type not identified", code: result.code ?? null, source: result.source || "Local knowledge base" };
}
function displayConfirmed(raw, match) {
  const e = match.entry;
  const record = candidateFrom(raw, { status: "Plastic", type: e.type, code: e.code, source: "Local knowledge base" });
  showBaseResult({ expression: "✓", label: "PLASTIC IDENTIFIED", title: titleCase(raw), sub: `${e.type}${e.code ? ` · Resin code #${e.code}` : ""}`, text: `“${raw}” matches Eco Count’s local knowledge base. Review the details, choose a quantity, and add it to your history when you're ready.`, material: e.type, why: e.note || "A common material for this type of item; packaging can vary by product.", source: "Local knowledge base", canAdd: true, candidate: record });
}
function displayAssumable(raw, match) {
  const e = match.entry;
  const record = candidateFrom(raw, { status: "Likely plastic", type: "Plastic — type not identified", code: null, source: "Local knowledge base" });
  showBaseResult({ expression: "~", label: "LIKELY PLASTIC", title: titleCase(raw), sub: "This item can be made from plastic", text: `“${raw}” can reasonably be made from plastic, but the exact material is not confirmed. Add it to your history if that matches the item you used.`, material: "Plastic · resin unknown", why: e.reason || "This item can be manufactured from plastic.", source: "Local knowledge base", canAdd: true, candidate: record });
}
function displayNonPlastic(raw, match) {
  const e = match.entry;
  showBaseResult({ expression: "↗", label: "NOT IDENTIFIED AS PLASTIC", title: titleCase(raw), sub: "Your plastic count stays the same", text: `Eco Count does not consider “${raw}” a plastic item based on the description. If the item has plastic parts or packaging, try a more specific description.`, material: "Non-plastic as described", why: e.reason || "The knowledge base does not classify this as plastic.", source: "Local knowledge base", canAdd: false, candidate: null });
}
function displayUnclear(raw, message = "There isn't enough reliable information to classify this item.") {
  showBaseResult({ expression: "?", label: "NEEDS A CLOSER LOOK", title: "I need a little more detail", sub: "Nothing has been added to your history", text: `${message} Try a more specific description, or use the camera scan with a clear photo of the item or its material label.`, material: "Unknown", why: "Eco Count could not establish a reliable yes/no classification.", source: "Local data + Gemini AI", canAdd: false, grid: true });
}
function displayUnavailable(raw, message) {
  showBaseResult({ expression: "!", label: "VERIFICATION UNAVAILABLE", title: "Couldn't verify this item", sub: "Nothing has been added to your history", text: `${message} You can retry, or use a common item name that may be in the local knowledge base.`, material: "Unknown", why: "No reliable classification was returned.", source: "Local data + Gemini AI", canAdd: false, grid: true });
}
async function geminiVerify(raw, image = null) {
  const cached = image ? null : getCachedVerification(raw);
  if (cached) { applyGeminiResult(raw, cached, Boolean(image)); return; }
  if (!isBackendConfigured()) { displayUnavailable(raw, "The Gemini verification backend is not connected."); return; }
  els.button.disabled = true;
  els.button.innerHTML = image ? "Scanning photo…" : "Checking with AI…";
  try {
    const body = { item: raw || "Identify the item shown in the photo" };
    if (image) body.image = { mimeType: image.mimeType, data: image.data };
    const response = await fetch(VERIFY_API_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      if (response.status === 429) throw new Error(payload?.error || "Gemini's free verification limit is temporarily unavailable.");
      if (response.status === 503) throw new Error(payload?.error || "Gemini verification is temporarily unavailable.");
      throw new Error(payload?.error || `Verification backend returned HTTP ${response.status}.`);
    }
    if (!payload || !["YES", "NO", "UNCLEAR"].includes(payload.verdict)) throw new Error("The verification backend returned an invalid classification.");
    if (!image && raw) cacheVerification(raw, payload);
    applyGeminiResult(raw, payload, Boolean(image));
  } catch (error) {
    console.error(error);
    displayUnavailable(raw, error.message || "Gemini verification could not return a reliable result.");
  } finally {
    els.button.disabled = false;
    els.button.innerHTML = 'Check item <span aria-hidden="true">→</span>';
  }
}
function applyGeminiResult(raw, result, wasPhoto = false) {
  const sources = Array.isArray(result.sources) ? result.sources.filter(source => source?.url).slice(0, 5) : [];
  const detectedName = String(result.identified_item || "").trim();
  const itemName = wasPhoto ? (detectedName || raw || "Scanned item") : raw;
  if (result.verdict === "YES") {
    const displayName = itemName;
    const record = candidateFrom(displayName, { status: "Likely plastic", type: "Plastic — type not identified", code: null, source: "Gemini AI" });
    showBaseResult({ expression: "✓", label: "LIKELY PLASTIC", title: titleCase(displayName), sub: wasPhoto ? "Gemini identified the item in your photo" : "Gemini says this item can be plastic", text: wasPhoto ? `The photo appears to show “${displayName}”. Review the result before recording it. Material and recycling details can vary by product.` : `Gemini's classification supports treating “${displayName}” as plastic. Review it and choose the quantity before adding it to your history.`, material: "Plastic · exact resin not established", why: result.reason || "The item can reasonably be made from plastic.", source: "Gemini AI", sourceLinks: sources, canAdd: true, candidate: record });
    return;
  }
  if (result.verdict === "NO") {
    showBaseResult({ expression: "↗", label: "NOT IDENTIFIED AS PLASTIC", title: titleCase(itemName), sub: "Your plastic count stays the same", text: `Gemini does not find enough reason to classify “${itemName}” as a plastic item. If it has plastic parts or packaging, try a more specific description or another photo.`, material: "Non-plastic as described", why: result.reason || "The available information does not support a plastic classification.", source: "Gemini AI", sourceLinks: sources, canAdd: false });
    return;
  }
  displayUnclear(itemName, result.reason || "Gemini could not confidently tell whether this item can be plastic.");
  if (sources.length) els.sourcesBox.innerHTML = sources.map(link => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.title || "Open source")}</a>`).join("");
}
async function classify(raw, image = null) {
  if (!image) {
    const match = localMatch(raw);
    if (match?.type === "confirmed") return displayConfirmed(raw, match);
    if (match?.type === "nonplastic") return displayNonPlastic(raw, match);
    if (match?.type === "assumable") return displayAssumable(raw, match);
  }
  await geminiVerify(raw, image);
}

els.form.addEventListener("submit", async event => {
  event.preventDefault();
  const raw = els.input.value.trim();
  if (!raw && !selectedPhoto) {
    showBaseResult({ expression: "→", label: "READY WHEN YOU ARE", title: "What did you use?", sub: "Type an item or scan a photo", text: "Try a specific item like “water bottle”, “food wrapper”, or “plastic cup”.", material: "—", why: "A more specific description helps Eco Count classify the item accurately.", source: "Local knowledge base", canAdd: false });
    els.input.focus();
    return;
  }
  try {
    if (knowledgeReady) await knowledgeReady;
    const image = selectedPhoto ? { mimeType: selectedPhoto.mimeType, data: selectedPhoto.data } : null;
    await classify(raw || "", image);
  } catch (error) {
    console.error(error);
    displayUnavailable(raw, "Eco Count could not load its local knowledge base.");
  }
});
els.dismiss.addEventListener("click", () => { els.result.hidden = true; els.input.focus(); });

function makeRecord(candidate, quantity) {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, item: candidate.item.trim().slice(0, 120), quantity: safeQuantity(quantity), status: candidate.status, type: candidate.type, code: candidate.code ?? null, source: candidate.source, timestamp: new Date().toISOString() };
}
els.addToHistory.addEventListener("click", () => {
  if (!currentCandidate) return;
  const quantity = safeQuantity(els.quantityInput.value);
  els.quantityInput.value = String(quantity);
  const record = makeRecord(currentCandidate, quantity);
  history.unshift(record);
  if (!saveHistory()) { history.shift(); return; }
  renderDashboard();
  els.addedMessage.textContent = `Added ${quantity} ${quantity === 1 ? "item" : "items"} to your history.`;
  els.addedMessage.hidden = false;
  els.addToHistory.innerHTML = 'Add another <span aria-hidden="true">+</span>';
  showToast(`${quantity} ${quantity === 1 ? "item" : "items"} added to history`);
  selectedPhoto = null;
  els.photoPreview.hidden = true;
  els.cameraInput.value = "";
});
$("quantityMinus").addEventListener("click", () => { els.quantityInput.value = String(Math.max(1, safeQuantity(els.quantityInput.value) - 1)); });
$("quantityPlus").addEventListener("click", () => { els.quantityInput.value = String(Math.min(999, safeQuantity(els.quantityInput.value) + 1)); });
els.quantityInput.addEventListener("change", () => { els.quantityInput.value = String(safeQuantity(els.quantityInput.value)); });

// Compress and resize a selected image before sending it to the Gemini backend.
async function prepareImage(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  if (file.size > 15 * 1024 * 1024) throw new Error("That image is very large. Choose a photo under 15 MB.");
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = imageUrl;
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("The selected image could not be opened.")); });
    const maxDimension = 1000;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", .76);
    const data = dataUrl.split(",")[1];
    if (!data || data.length > 1_350_000) throw new Error("The photo is still too large after compression. Try a smaller image.");
    return { name: file.name || "Camera photo", preview: dataUrl, data, mimeType: "image/jpeg" };
  } finally { URL.revokeObjectURL(imageUrl); }
}
els.cameraButton.addEventListener("click", () => els.cameraInput.click());
els.cameraInput.addEventListener("change", async () => {
  const file = els.cameraInput.files?.[0];
  if (!file) return;
  els.cameraButton.disabled = true;
  try {
    selectedPhoto = await prepareImage(file);
    els.previewImage.src = selectedPhoto.preview;
    els.previewName.textContent = selectedPhoto.name;
    els.photoPreview.hidden = false;
    if (!els.input.value.trim()) els.input.placeholder = "Optional: describe the item in your photo…";
    els.input.focus();
    showToast("Photo ready. Add a description if it helps, then check the item.");
  } catch (error) { showToast(error.message || "Could not prepare that photo."); els.cameraInput.value = ""; }
  finally { els.cameraButton.disabled = false; }
});
function clearPhoto() {
  selectedPhoto = null; els.cameraInput.value = ""; els.photoPreview.hidden = true; els.previewImage.removeAttribute("src");
  els.input.placeholder = "e.g. water bottle, food wrapper, cup…";
}
els.removePhoto.addEventListener("click", clearPhoto);

function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
function shiftDay(date, amount) { const d = new Date(date); d.setDate(d.getDate() + amount); return d; }
function sumSince(from, until) { return history.reduce((sum, entry) => { const d = new Date(entry.timestamp); return d >= from && d < until ? sum + safeQuantity(entry.quantity) : sum; }, 0); }
function getWeeklyData() {
  const today = startOfDay(new Date());
  return Array.from({ length: 7 }, (_, index) => {
    const date = shiftDay(today, index - 6);
    const key = localDateKey(date);
    const count = history.reduce((sum, entry) => sum + (localDateKey(new Date(entry.timestamp)) === key ? safeQuantity(entry.quantity) : 0), 0);
    return { date, key, count, label: date.toLocaleDateString(undefined, { weekday: "short" }) };
  });
}
function iconForItem(item) {
  const name = normalize(item);
  if (/bottle|flask|jug/.test(name)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v3l2 2v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V8l2-2z"/><path d="M9 10h6M9 14h6M9 18h6"/></svg>';
  if (/cup|glass|tumbler/.test(name)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14l-1.5 15h-11zM4 5h16M8 3h8"/></svg>';
  if (/bag|sachet|packet|wrapper|packaging/.test(name)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8 8 4h8l3 4-1 12H6zM5 8h14M8 12h8"/></svg>';
  if (/container|box|tray|lunch/.test(name)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 9 3-4h12l3 4-2 10H5zM3 9h18M8 13h8"/></svg>';
  if (/straw/.test(name)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21 13 4h5M13 4l2-2"/></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16l-1 13H5zM3 7l2-3h14l2 3M9 10v6M15 10v6"/></svg>';
}
function renderStats() {
  const now = startOfDay(new Date());
  const thisWeek = sumSince(shiftDay(now, -6), shiftDay(now, 1));
  const previousWeek = sumSince(shiftDay(now, -13), shiftDay(now, -6));
  const allCount = totalCount();
  els.countPill.textContent = allCount.toLocaleString();
  els.weekCount.textContent = thisWeek.toLocaleString();
  if (!history.length) els.weekCompare.textContent = "Start with your first item";
  else if (!previousWeek) els.weekCompare.textContent = "Your first tracking week";
  else {
    const delta = thisWeek - previousWeek;
    els.weekCompare.textContent = `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)} ${Math.abs(delta) === 1 ? "item" : "items"} vs. last week`;
    els.weekCompare.classList.toggle("positive-change", delta < 0);
    els.weekCompare.classList.toggle("negative-change", delta > 0);
  }
  els.uniqueCount.textContent = new Set(history.map(entry => normalize(entry.item)).filter(Boolean)).size.toLocaleString();
  const totalsByItem = new Map();
  history.forEach(entry => { const key = normalize(entry.item); const value = totalsByItem.get(key) || { item: entry.item, count: 0 }; value.count += safeQuantity(entry.quantity); totalsByItem.set(key, value); });
  const top = [...totalsByItem.values()].sort((a, b) => b.count - a.count || a.item.localeCompare(b.item))[0];
  els.topItem.textContent = top ? titleCase(top.item) : "—";
  els.topItemCount.textContent = top ? `${top.count} ${top.count === 1 ? "item" : "items"} recorded` : "Waiting for your first entry";
  renderChart();
  renderRecommendation(top);
}
function renderChart() {
  const data = getWeeklyData();
  const max = Math.max(1, ...data.map(x => x.count));
  els.weeklyChart.innerHTML = data.map((d, index) => {
    const height = d.count ? Math.max(7, (d.count / max) * 83) : 3;
    const isToday = index === data.length - 1;
    return `<div class="chart-day" title="${escapeHtml(d.date.toLocaleDateString())}: ${d.count} ${d.count === 1 ? "item" : "items"}"><div class="chart-bar-wrap">${d.count ? `<span class="chart-value">${d.count}</span>` : ""}<div class="chart-bar${isToday ? " today" : ""}" style="height:${height}%"></div></div><label>${escapeHtml(d.label)}</label></div>`;
  }).join("");
  const total = data.reduce((sum, day) => sum + day.count, 0);
  els.weeklyChart.setAttribute("aria-label", `Last seven days: ${data.map(d => `${d.label} ${d.count}`).join(", ")}. Total ${total} items.`);
  els.chartFoot.textContent = total ? `${total} ${total === 1 ? "item" : "items"} recorded in the last 7 days. These counts come from your saved history.` : "Your daily count will appear here as you track items.";
}
function renderRecommendation(top) {
  if (!top) {
    els.recommendationTitle.textContent = "Small habits add up.";
    els.recommendationText.textContent = "Start by tracking what you use. Eco Count will suggest a practical change based on your most common items.";
    els.recommendationAction.textContent = "Check your first item →";
    els.recommendationAction.dataset.action = "start";
    return;
  }
  const item = normalize(top.item);
  if (/bottle|flask|water/.test(item)) {
    els.recommendationTitle.textContent = "Try a reusable water bottle";
    els.recommendationText.textContent = `You've recorded ${top.count} ${top.count === 1 ? "bottle-related item" : "bottle-related items"}. Keep a refillable bottle with you to reduce reliance on disposable ones.`;
  } else if (/bag|shopping/.test(item)) {
    els.recommendationTitle.textContent = "Keep a reusable bag close";
    els.recommendationText.textContent = `You've recorded ${top.count} bag-related ${top.count === 1 ? "item" : "items"}. Keeping a tote in your backpack can help avoid an extra bag when shopping.`;
  } else if (/cup|straw|takeaway|container|food|wrapper|packet/.test(item)) {
    els.recommendationTitle.textContent = "Choose reusables when practical";
    els.recommendationText.textContent = `Packaging appears often in your history. When it suits the situation, bring a reusable cup or container and choose less-packaged options.`;
  } else {
    els.recommendationTitle.textContent = "Notice your most common item";
    els.recommendationText.textContent = `“${titleCase(top.item)}” is your most logged item. Look for one realistic reusable or lower-packaging alternative that suits your routine.`;
  }
  els.recommendationAction.textContent = "Explore your history →";
  els.recommendationAction.dataset.action = "history";
}
els.recommendationAction.addEventListener("click", () => {
  if (els.recommendationAction.dataset.action === "start") { els.input.focus(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  else { $("historySection").scrollIntoView({ behavior: "smooth", block: "start" }); els.historySearch.focus({ preventScroll: true }); }
});
function renderHistory() {
  const term = normalize(els.historySearch.value);
  let filtered = history.filter(entry => !term || normalize(entry.item).includes(term) || normalize(entry.type).includes(term) || normalize(entry.code).includes(term));
  filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const totalFiltered = filtered.length;
  if (!showAllHistory && !term) filtered = filtered.slice(0, 4);
  els.viewAll.hidden = totalFiltered <= 4 && !showAllHistory;
  if (totalFiltered <= 4 && showAllHistory) els.viewAll.hidden = true;
  els.viewAll.innerHTML = showAllHistory ? 'Show recent <span aria-hidden="true">↑</span>' : 'View all <span aria-hidden="true">→</span>';
  els.history.innerHTML = "";
  if (!filtered.length) {
    const message = history.length ? "No items match that search." : "Check an item above and add it to begin tracking your plastic footprint.";
    const title = history.length ? "No matching items." : "Your history starts here.";
    els.history.innerHTML = `<div class="history-empty"><span class="empty-mark" aria-hidden="true">✳</span><strong>${title}</strong><span>${escapeHtml(message)}</span></div>`;
    $("historySummary").textContent = history.length ? "Try a different search." : "The items you record will appear here.";
    return;
  }
  $("historySummary").textContent = `${totalCount(history).toLocaleString()} items across ${history.length.toLocaleString()} entries${term ? ` · ${totalFiltered} matching entries` : ""}.`;
  const groups = new Map();
  filtered.forEach(entry => {
    const date = new Date(entry.timestamp);
    const key = localDateKey(date);
    if (!groups.has(key)) groups.set(key, { date, entries: [] });
    groups.get(key).entries.push(entry);
  });
  for (const [key, group] of groups) {
    const section = document.createElement("section");
    section.className = "history-day";
    const label = document.createElement("div");
    label.className = "history-day-label";
    label.textContent = dateLabel(group.date);
    section.appendChild(label);
    group.entries.forEach(entry => {
      const row = document.createElement("div");
      row.className = "history-row";
      row.dataset.id = entry.id;
      const info = document.createElement("div");
      info.className = "history-item-info";
      const thumb = document.createElement("div");
      thumb.className = "item-thumb";
      thumb.innerHTML = iconForItem(entry.item);
      const nameWrap = document.createElement("div");
      nameWrap.className = "history-name-wrap";
      const name = document.createElement("div");
      name.className = "history-name";
      name.textContent = titleCase(entry.item);
      const detail = document.createElement("div");
      detail.className = "history-detail";
      const material = document.createElement("span");
      material.className = "badge";
      material.textContent = entry.code ? `${entry.type} · ${entry.code}` : entry.type;
      detail.appendChild(material);
      if (entry.status === "Likely plastic") {
        const likely = document.createElement("span"); likely.className = "badge"; likely.textContent = "Likely"; detail.appendChild(likely);
      }
      nameWrap.append(name, detail); info.append(thumb, nameWrap);
      const quantity = document.createElement("div"); quantity.className = "history-quantity"; quantity.textContent = `${safeQuantity(entry.quantity)} ${safeQuantity(entry.quantity) === 1 ? "item" : "items"}`;
      const time = document.createElement("time"); time.className = "history-time"; time.dateTime = entry.timestamp; time.textContent = formatTime(entry.timestamp);
      const menuWrap = document.createElement("div"); menuWrap.className = "row-menu-wrap";
      const menuButton = document.createElement("button"); menuButton.className = "row-menu-button"; menuButton.type = "button"; menuButton.setAttribute("aria-label", `Actions for ${entry.item}`); menuButton.setAttribute("aria-expanded", "false"); menuButton.textContent = "···"; menuButton.dataset.action = "toggle-row-menu"; menuButton.dataset.id = entry.id;
      const menu = document.createElement("div"); menu.className = "row-menu"; menu.hidden = true;
      const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit entry"; edit.dataset.action = "edit"; edit.dataset.id = entry.id;
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Delete entry"; remove.className = "delete-action"; remove.dataset.action = "delete"; remove.dataset.id = entry.id;
      menu.append(edit, remove); menuWrap.append(menuButton, menu);
      row.append(info, quantity, time, menuWrap); section.appendChild(row);
    });
    els.history.appendChild(section);
  }
}
function dateLabel(date) {
  const today = startOfDay(new Date());
  const dateDay = startOfDay(date);
  if (dateDay.getTime() === today.getTime()) return "Today";
  if (dateDay.getTime() === shiftDay(today, -1).getTime()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
}
function formatTime(value) { return new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function renderDashboard() { renderStats(); renderHistory(); }
els.history.addEventListener("click", event => {
  const actionButton = event.target.closest("button[data-action]");
  if (!actionButton) { if (!event.target.closest(".row-menu-wrap")) closeRowMenus(); return; }
  const { action, id } = actionButton.dataset;
  if (action === "toggle-row-menu") {
    const menu = actionButton.parentElement.querySelector(".row-menu");
    const willOpen = menu.hidden;
    closeRowMenus(); menu.hidden = !willOpen; actionButton.setAttribute("aria-expanded", String(willOpen));
  } else if (action === "edit") {
    closeRowMenus(); openEditor(id);
  } else if (action === "delete") {
    closeRowMenus(); deleteRecord(id);
  }
});
function closeRowMenus() {
  els.history.querySelectorAll(".row-menu").forEach(menu => { menu.hidden = true; });
  els.history.querySelectorAll('.row-menu-button[aria-expanded="true"]').forEach(button => button.setAttribute("aria-expanded", "false"));
}
function openEditor(id) {
  const entry = history.find(item => item.id === id);
  if (!entry) return;
  editingId = id; els.editItemInput.value = entry.item; els.editQuantityInput.value = String(safeQuantity(entry.quantity));
  if (typeof els.editDialog.showModal === "function") els.editDialog.showModal(); else { const item = window.prompt("Edit item name", entry.item); if (item) updateRecord(id, item, entry.quantity); }
}
function closeEditor() { editingId = null; if (els.editDialog.open) els.editDialog.close(); }
function updateRecord(id, item, quantity) {
  const normalizedName = String(item || "").trim();
  if (!normalizedName) { showToast("Enter an item name."); return false; }
  const index = history.findIndex(entry => entry.id === id);
  if (index < 0) return false;
  const previousEntry = history[index];
  history[index] = { ...history[index], item: normalizedName.slice(0, 120), quantity: safeQuantity(quantity) };
  if (!saveHistory()) { history[index] = previousEntry; return false; }
  renderDashboard(); showToast("Entry updated."); return true;
}
els.editForm.addEventListener("submit", event => {
  event.preventDefault();
  if (updateRecord(editingId, els.editItemInput.value, els.editQuantityInput.value)) closeEditor();
});
els.closeEdit.addEventListener("click", closeEditor);
els.cancelEdit.addEventListener("click", closeEditor);
els.editDialog.addEventListener("click", event => { if (event.target === els.editDialog) closeEditor(); });
function deleteRecord(id) {
  const entry = history.find(item => item.id === id);
  if (!entry) return;
  if (!window.confirm(`Delete “${entry.item}” from your history?`)) return;
  const previousHistory = history;
  history = history.filter(item => item.id !== id);
  if (!saveHistory()) { history = previousHistory; return; }
  renderDashboard(); showToast("Entry deleted.");
}
els.clearHistory.addEventListener("click", clearAllHistory);
function clearAllHistory() {
  closeSiteMenu();
  if (!history.length) { showToast("Your history is already empty."); return; }
  if (!window.confirm("Clear your entire plastic history and reset all counts? This cannot be undone. Export a backup first if you need one.")) return;
  const previous = history; history = [];
  if (!saveHistory()) history = previous;
  renderDashboard(); els.result.hidden = true; showToast("History cleared.");
}
els.historySearch.addEventListener("input", () => { showAllHistory = Boolean(els.historySearch.value.trim()); renderHistory(); });
els.viewAll.addEventListener("click", () => { showAllHistory = !showAllHistory; renderHistory(); });

function closeSiteMenu() { els.siteMenu.hidden = true; els.menuToggle.setAttribute("aria-expanded", "false"); }
els.menuToggle.addEventListener("click", () => { const open = els.siteMenu.hidden; els.siteMenu.hidden = !open; els.menuToggle.setAttribute("aria-expanded", String(open)); });
document.addEventListener("click", event => {
  if (!event.target.closest(".menu-wrap")) closeSiteMenu();
  if (!event.target.closest(".row-menu-wrap") && !event.target.closest("#history")) closeRowMenus();
});
document.addEventListener("keydown", event => { if (event.key === "Escape") { closeSiteMenu(); closeRowMenus(); } });
function downloadFile(filename, contents, mimeType) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(value) { const raw = String(value ?? ""); return `"${raw.replace(/"/g, '""')}"`; }
els.exportCsv.addEventListener("click", () => {
  closeSiteMenu();
  const columns = ["item", "quantity", "status", "material", "resin_code", "source", "timestamp"];
  const rows = history.slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)).map(entry => [entry.item, entry.quantity, entry.status, entry.type, entry.code ?? "", entry.source, entry.timestamp]);
  downloadFile("eco-count-history.csv", [columns, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
  showToast("History exported as CSV.");
});
els.backupJson.addEventListener("click", () => {
  closeSiteMenu();
  downloadFile("eco-count-backup.json", JSON.stringify({ app: "Eco Count", version: 2, exportedAt: new Date().toISOString(), history }, null, 2), "application/json;charset=utf-8");
  showToast("Backup downloaded.");
});
els.importBackup.addEventListener("click", () => { closeSiteMenu(); els.backupInput.click(); });
els.backupInput.addEventListener("change", async () => {
  const file = els.backupInput.files?.[0]; if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("Backup file is too large.");
    const parsed = JSON.parse(await file.text());
    const records = Array.isArray(parsed) ? parsed : parsed.history;
    if (!Array.isArray(records)) throw new Error("This file does not contain an Eco Count history.");
    const sanitized = records.map(normalizeRecord).filter(Boolean).slice(0, 10000);
    if (!window.confirm(`Restore ${sanitized.length} entries? This will replace the history currently saved in this browser.`)) return;
    const previous = history; history = sanitized;
    if (!saveHistory()) history = previous;
    else { renderDashboard(); showToast(`Restored ${history.length} entries.`); }
  } catch (error) { showToast(error.message || "Could not read that backup file."); }
  finally { els.backupInput.value = ""; }
});

renderDashboard();
knowledgeReady = loadKnowledge();
window.ecoCountConfig = { model: MODEL_NAME, backendConfigured: isBackendConfigured(), photoScanning: true };
