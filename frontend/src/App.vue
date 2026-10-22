<script>
import { markRaw } from "vue";
import * as InventoryCore from "../../shared/inventory-core.js";
import { createApi, loadWorkbook, publishExcel } from "./transport.js";
const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 });

export default {
  data() {
    return {
      headers: InventoryCore.HEADERS,
      apiRoot: String(import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, ""),
      connectionState: "unconfigured", connectionMessage: "",
      workbook: null, fileMeta: null, sharedView: null, uploads: [], uploadId: "",
      selectedSheet: 0, selectedFile: null, preview: false, worker: null, parseTimer: null,
      parsing: false, publishing: false, refreshing: false, dragDepth: 0,
      query: "", warehouse: "", movementType: "", pageSize: 50, page: 1,
      sortColumn: null, sortDirection: "asc", status: "", statusType: "",
      accessToken: "", adminPassword: "", loginError: "", loggingIn: false,
    };
  },
  computed: {
    configured() {
      if (!this.apiRoot) return ["http:", "https:"].includes(window.location.protocol);
      try {
        const url = new URL(this.apiRoot);
        return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
      } catch { return false; }
    },
    serviceLabel() {
      return { unconfigured: "共享服务未连接", loading: "正在连接", connected: "共享服务已连接", error: "共享服务连接失败" }[this.connectionState];
    },
    activeSheet() { return this.workbook?.sheets[this.selectedSheet] || null; },
    records() { return this.activeSheet?.records || []; },
    warehouses() { return [...new Set(this.records.map((record) => record.cells[8]).filter(Boolean))].sort(); },
    movementTypes() { return [...new Set(this.records.map((record) => record.cells[12]).filter(Boolean))].sort(); },
    filtered() {
      return InventoryCore.filterRecords(this.records, { query: this.query, warehouse: this.warehouse, type: this.movementType });
    },
    summary() { return InventoryCore.getSummary(this.filtered); },
    sorted() { return InventoryCore.sortRecords(this.filtered, this.sortColumn, this.sortDirection); },
    pageCount() { return Math.ceil(this.sorted.length / this.pageSize); },
    currentPage() { return Math.max(1, Math.min(this.page, this.pageCount || 1)); },
    pageRows() { return this.sorted.slice((this.currentPage - 1) * this.pageSize, this.currentPage * this.pageSize); },
    countLabel() {
      if (!this.workbook) return "尚未加载数据";
      if (!this.filtered.length) return `共 ${this.format(this.records.length)} 条，当前没有匹配记录`;
      const start = (this.currentPage - 1) * this.pageSize + 1;
      const end = Math.min(this.currentPage * this.pageSize, this.filtered.length);
      return `第 ${this.format(start)}–${this.format(end)} 条，共 ${this.format(this.filtered.length)} 条`;
    },
    fileDescription() {
      if (!this.fileMeta) return "选择一份 Excel 文件开始查看";
      const prefix = this.preview ? "预览" : "已发布";
      const time = this.fileMeta.uploadedAt ? ` · ${this.formatTime(this.fileMeta.uploadedAt)}` : "";
      return `${prefix}：${this.fileMeta.fileName}${time}`;
    },
  },
  watch: {
    query() { this.page = 1; }, warehouse() { this.page = 1; }, movementType() { this.page = 1; }, pageSize() { this.page = 1; },
    selectedSheet() { this.resetFilters(); },
  },
  methods: {
    format(value) { return numberFormatter.format(value); },
    formatTime(value) {
      const date = new Date(value);
      return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(date);
    },
    setStatus(message, type = "") { this.status = message; this.statusType = type; },
    resetFilters() {
      this.query = ""; this.warehouse = ""; this.movementType = "";
      this.page = 1; this.sortColumn = null; this.sortDirection = "asc";
    },
    sortBy(column) {
      this.sortDirection = this.sortColumn === column && this.sortDirection === "asc" ? "desc" : "asc";
      this.sortColumn = column; this.page = 1;
    },
    rowClass(index) {
      return { "sku-column": index === 0, "name-column": index === 1, "time-column": index === 3, "type-column": index === 12, numeric: InventoryCore.NUMERIC_COLUMNS.has(index) };
    },
    async api(path, options = {}) {
      if (!this.configured) throw new Error("请使用 HTTPS 接口地址，本机开发可使用 HTTP");
      try { return await createApi({ root: this.apiRoot, token: () => this.accessToken })(path, options); }
      catch (error) { if (error.status === 401) this.accessToken = ""; throw error; }
    },
    async refreshShared() {
      if (!this.configured || this.refreshing || this.publishing) return;
      this.refreshing = true;
      this.connectionState = "loading";
      try {
        const result = await this.api("/api/uploads");
        this.uploads = result.items;
        this.connectionState = "connected";
        this.connectionMessage = "";
        if (this.uploads.length) await this.loadShared(this.uploads[0].id);
        else if (!this.preview) {
          this.workbook = null; this.fileMeta = null; this.uploadId = ""; this.sharedView = null;
        }
      } catch (error) {
        this.connectionState = "error"; this.connectionMessage = error.message;
      } finally { this.refreshing = false; }
    },
    async loadShared(id) {
      if (!id) return;
      try {
        const data = await loadWorkbook((path, options) => this.api(path, options), id);
        const workbook = markRaw(InventoryCore.hydrateWorkbook(data));
        this.cancelParsing();
        this.workbook = workbook;
        this.fileMeta = { fileName: data.fileName, uploadedAt: data.uploadedAt };
        this.sharedView = { workbook, fileMeta: this.fileMeta, id: data.id };
        this.uploadId = data.id; this.selectedSheet = 0; this.selectedFile = null; this.preview = false;
        this.resetFilters();
      } catch (error) {
        this.setStatus(error.message, "error");
        throw error;
      }
    },
    chooseFile() { this.$refs.fileInput.click(); },
    onFileInput(event) {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) this.readFile(file);
    },
    onDrop(event) {
      this.dragDepth = 0;
      const files = event.dataTransfer?.files;
      if (files?.length !== 1) { this.setStatus("请每次选择一个 Excel 文件", "error"); return; }
      this.readFile(files[0]);
    },
    cancelParsing() {
      if (this.worker) this.worker.terminate();
      clearTimeout(this.parseTimer);
      this.worker = null; this.parsing = false;
    },
    async readFile(file) {
      if (this.publishing) return;
      if (!/\.xlsx$/i.test(file.name)) { this.setStatus("请选择 .xlsx 格式的 Excel 文件", "error"); return; }
      if (!file.size || file.size > 20 * 1024 * 1024) { this.setStatus("请选择不超过 20 MB 的非空文件", "error"); return; }
      this.cancelParsing();
      this.parsing = true; this.setStatus(`正在读取 ${file.name}…`);
      const worker = markRaw(new Worker(new URL("./excel-worker.js", import.meta.url), { type: "module" }));
      this.worker = worker;
      const fail = (message) => {
        if (this.worker !== worker) return;
        this.cancelParsing();
        this.setStatus(message + (this.workbook ? "，当前显示的数据已保留。" : "。"), "error");
      };
      this.parseTimer = setTimeout(() => fail("解析超时，请拆分文件后重试"), 45000);
      worker.onerror = () => fail("Excel 解析组件加载失败，请刷新页面重试");
      worker.onmessage = (event) => {
        if (this.worker !== worker) return;
        if (!event.data.ok) { fail(event.data.error); return; }
        this.workbook = markRaw(event.data.workbook);
        this.selectedFile = markRaw(file); this.fileMeta = { fileName: file.name };
        this.preview = true; this.selectedSheet = 0; this.resetFilters();
        this.cancelParsing();
        const count = this.workbook.sheets.reduce((sum, sheet) => sum + sheet.records.length, 0);
        const skipped = this.workbook.skippedSheets.length;
        this.setStatus(`已读取 ${this.format(count)} 条记录、${this.workbook.sheets.length} 个工作表。${skipped ? `已跳过 ${skipped} 个不匹配的工作表。` : ""}确认预览后可发布共享数据。`, "success");
      };
      try {
        const buffer = await file.arrayBuffer();
        if (this.worker === worker) worker.postMessage(buffer, [buffer]);
      } catch { fail("无法读取所选文件，请重新选择"); }
    },
    cancelPreview() {
      this.cancelParsing();
      this.preview = false; this.selectedFile = null; this.selectedSheet = 0;
      this.workbook = this.sharedView?.workbook || null;
      this.fileMeta = this.sharedView?.fileMeta || null;
      this.uploadId = this.sharedView?.id || "";
      this.resetFilters(); this.setStatus("");
    },
    openLogin() {
      if (this.accessToken) { this.accessToken = ""; this.setStatus("已退出管理员登录"); return; }
      this.adminPassword = ""; this.loginError = "";
      this.$refs.adminDialog.showModal();
    },
    closeLogin() { this.adminPassword = ""; this.$refs.adminDialog.close(); },
    async login() {
      if (this.loggingIn) return;
      this.loggingIn = true; this.loginError = "";
      try {
        const result = await this.api("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: this.adminPassword }) });
        this.accessToken = result.accessToken;
        this.closeLogin(); this.setStatus("登录成功，可以发布预览中的数据。", "success");
      } catch (error) { this.loginError = error.message; }
      finally { this.loggingIn = false; }
    },
    async publish() {
      if (!this.preview || !this.selectedFile || this.publishing || this.parsing) return;
      if (!this.configured) { this.setStatus("共享服务尚未配置，当前文件仅供预览，尚未保存到数据库。", "error"); return; }
      if (!this.accessToken) { this.openLogin(); return; }
      this.publishing = true; this.setStatus("正在上传并保存到 MySQL，请稍候…");
      let saved = null;
      try {
        const result = await publishExcel({
          api: (path, options) => this.api(path, options), file: this.selectedFile,
          scope: this.apiRoot || window.location.origin,
          onProgress: ({ phase, done, total }) => this.setStatus(phase === "publishing"
            ? "正在校验完整 Excel 并保存到 MySQL，请稍候…"
            : `正在上传 ${done}/${total} 个分块（${Math.round(done / total * 100)}%），支持失败后重试续传…`),
        });
        saved = result;
        this.preview = false; this.selectedFile = null;
        this.fileMeta = { fileName: result.fileName, uploadedAt: result.uploadedAt };
        this.sharedView = { workbook: this.workbook, fileMeta: this.fileMeta, id: result.id };
        this.uploadId = result.id;
        this.uploads = (await this.api("/api/uploads")).items;
        await this.loadShared(result.id);
        this.connectionState = "connected";
        this.setStatus(result.duplicate ? "这份文件已存在，已切换到对应的共享记录。" : "已保存到 MySQL 并发布。其他访客打开网页即可查看。", "success");
      } catch (error) { this.setStatus(saved ? "数据已保存，但刷新共享记录失败。请点击刷新共享数据重试。" : `${error.message}。重新选择同一文件后可重试；若发布已完成，会自动返回原记录。`, "error"); }
      finally { this.publishing = false; }
    },
    preventFileNavigation(event) {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    },
  },
  mounted() {
    window.addEventListener("dragover", this.preventFileNavigation);
    window.addEventListener("drop", this.preventFileNavigation);
    if (this.apiRoot && !this.configured) this.connectionMessage = "接口地址需使用 HTTPS；本机开发可使用 localhost 或 127.0.0.1。";
    this.refreshShared();
  },
  beforeUnmount() {
    this.cancelParsing();
    window.removeEventListener("dragover", this.preventFileNavigation);
    window.removeEventListener("drop", this.preventFileNavigation);
  },
};
</script>

<template>
<div class="wrap">
  <header class="header">
    <a class="brand" href="./" aria-label="SZ Labs 首页"><span class="brand-mark" aria-hidden="true">s.</span><span class="brand-name">SZ LABS</span></a>
    <div class="header-actions"><span class="environment" :class="{connected: connectionState === 'connected'}" id="service-state">{{ serviceLabel }}</span><button class="button button-quiet" id="admin-button" :disabled="publishing" @click="openLogin">{{ accessToken ? '退出登录' : '管理员登录' }}</button></div>
  </header>
  <main>
    <section class="page-heading" aria-labelledby="welcome-title"><div><p class="eyebrow">INVENTORY / 库存工作台</p><h1 id="welcome-title">库存更新记录<span class="title-dot">.</span></h1><p class="page-description">每一笔变动，都清楚可查。</p></div><button class="button button-quiet" id="refresh-button" :disabled="!configured || refreshing || publishing" @click="refreshShared"><span aria-hidden="true">↻</span> {{ refreshing ? '正在刷新…' : '刷新共享数据' }}</button></section>
    <section class="upload-zone" :class="{'drag-over': dragDepth > 0}" :aria-busy="parsing" @dragenter.prevent="dragDepth++" @dragover.prevent @dragleave.prevent="dragDepth = Math.max(0, dragDepth - 1)" @drop.prevent="onDrop" aria-label="导入 Excel 文件">
      <div class="upload-copy"><span class="file-icon" aria-hidden="true">↥</span><div><h2>{{ parsing ? '正在解析 Excel…' : '将 Excel 文件拖到这里' }}</h2><p>支持 .xlsx，最大 20 MB。先预览，确认后发布给访客查看。</p></div></div>
      <input ref="fileInput" id="file-input" class="sr-only" type="file" accept=".xlsx" aria-label="选择库存记录 Excel 文件" @change="onFileInput" />
      <button class="button button-primary" id="choose-file" :disabled="parsing || publishing" @click="chooseFile">选择 Excel 文件 <span aria-hidden="true">＋</span></button>
    </section>
    <div class="import-feedback" :class="statusType" id="import-status" role="status" aria-live="polite">{{ status }}</div>
    <p class="service-note" v-if="connectionState !== 'connected'">{{ connectionMessage || '共享服务尚未配置，可以先导入文件预览。配置后，管理员可发布数据供其他访客查看。' }}</p>
    <details class="format-help"><summary>查看支持的 Excel 表头</summary><p>使用库存更新记录格式，表头允许换序，包含以下 14 个字段：</p><div class="field-list"><span v-for="header in headers" :key="header">{{ header }}</span></div></details>
    <section class="statistics" aria-label="当前筛选数据统计">
      <article class="stat"><span>记录条数</span><strong id="stat-records">{{ workbook ? format(summary.count) : '—' }}</strong><small>当前筛选的变动记录</small></article>
      <article class="stat"><span>涉及 SKU</span><strong id="stat-skus">{{ workbook ? format(summary.skuCount) : '—' }}</strong><small>按 SKU 编号去重</small></article>
      <article class="stat"><span>入库数量</span><strong id="stat-in">{{ workbook ? format(summary.inQty) : '—' }}</strong><small>正向变动合计</small></article>
      <article class="stat"><span>出库数量</span><strong id="stat-out">{{ workbook ? format(summary.outQty) : '—' }}</strong><small>负向变动绝对值合计</small></article>
    </section>
    <p class="numeric-warning" v-if="summary.invalidChanges">{{ summary.invalidChanges }} 条变动数值无法识别，入库和出库数量未计入这些记录。</p>
    <section class="data-panel" aria-labelledby="records-title">
      <div class="panel-heading"><div><h2 id="records-title">数据明细</h2><p id="file-description">{{ fileDescription }}</p></div><div class="panel-actions" v-if="preview"><button class="button button-quiet" id="cancel-preview" :disabled="publishing" @click="cancelPreview">取消预览</button><button class="button button-primary" id="publish-button" :disabled="publishing || parsing" @click="publish">{{ publishing ? '正在发布…' : (accessToken ? '发布共享数据' : '登录后发布') }}</button></div></div>
      <div class="source-controls"><label>上传记录<select id="upload-select" :value="uploadId" :disabled="!uploads.length || publishing" @change="loadShared($event.target.value).catch(() => {})"><option v-if="!uploads.length" value="">暂无共享记录</option><option v-for="upload in uploads" :key="upload.id" :value="upload.id">{{ upload.fileName }} · {{ formatTime(upload.uploadedAt) }}</option></select></label><label>工作表<select id="sheet-select" v-model.number="selectedSheet" :disabled="!workbook || publishing"><option v-if="!workbook" :value="0">等待导入</option><option v-for="(sheet, index) in workbook?.sheets || []" :key="index" :value="index">{{ sheet.name }}</option></select></label><span class="preview-label" v-if="preview">文件预览 · 尚未发布</span></div>
      <div class="filters"><label class="search-field"><span class="sr-only">搜索所有字段</span><span aria-hidden="true">⌕</span><input id="search-input" v-model="query" type="search" placeholder="搜索 SKU、名称、账号或单据号…" :disabled="!workbook" /></label><label><span class="sr-only">筛选仓库</span><select id="warehouse-filter" v-model="warehouse" :disabled="!workbook"><option value="">全部仓库</option><option v-for="name in warehouses" :key="name">{{ name }}</option></select></label><label><span class="sr-only">筛选类型</span><select id="type-filter" v-model="movementType" :disabled="!workbook"><option value="">全部类型</option><option v-for="name in movementTypes" :key="name">{{ name }}</option></select></label><button class="reset-button" id="reset-filters" :disabled="!workbook" @click="resetFilters">重置筛选</button></div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="库存变动明细，可横向滚动查看全部字段" v-if="pageRows.length"><table><caption class="sr-only">库存更新记录，包含 14 个原始字段。点击列标题排序。</caption><thead><tr><th class="row-number" scope="col">行号</th><th v-for="(header, index) in headers" :key="header" :class="rowClass(index)" :aria-sort="sortColumn === index ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'" scope="col"><button class="sort-button" @click="sortBy(index)"><span>{{ header }}</span><span aria-hidden="true">{{ sortColumn === index ? (sortDirection === 'asc' ? '↑' : '↓') : '↕' }}</span></button></th></tr></thead><tbody id="table-body"><tr v-for="record in pageRows" :key="record.rowNumber"><td class="row-number">{{ record.rowNumber }}</td><td v-for="(value, index) in record.cells" :key="index" :title="value" :class="[rowClass(index), {'movement-positive': index === 6 && record.change > 0, 'movement-negative': index === 6 && record.change < 0}]">{{ value || '—' }}</td></tr></tbody></table></div>
      <div class="empty-state" v-else><span aria-hidden="true">▤</span><h3>{{ workbook ? '没有匹配的记录' : '还没有记录' }}</h3><p>{{ workbook ? '试试更换关键词或重置筛选。' : '导入 Excel 文件，或连接共享服务读取已发布的数据。' }}</p></div>
      <div class="table-footer"><span id="record-count" role="status">{{ countLabel }}</span><div class="pagination"><label>每页 <select id="page-size" v-model.number="pageSize" aria-label="每页条数"><option :value="25">25</option><option :value="50">50</option><option :value="100">100</option><option :value="200">200</option></select> 条</label><button class="page-button" aria-label="上一页" :disabled="currentPage <= 1" @click="page = currentPage - 1">‹</button><span id="page-number">{{ pageCount ? currentPage : 0 }} / {{ pageCount }}</span><button class="page-button" aria-label="下一页" :disabled="currentPage >= pageCount" @click="page = currentPage + 1">›</button></div></div>
      <p class="table-hint">统计随筛选更新。库存原值与新值是每笔记录的快照，不作跨记录累加。</p>
    </section>
  </main>
  <footer class="footer"><span>© 2026 SZ Labs</span><span>库存工作台 · Test</span></footer>
</div>
<dialog ref="adminDialog" aria-labelledby="admin-title" @close="adminPassword = ''"><form @submit.prevent="login"><div class="dialog-heading"><h2 id="admin-title">管理员登录</h2><button class="close-button" type="button" aria-label="关闭登录窗口" @click="closeLogin">×</button></div><p>访客可以查看已发布记录。管理员登录后可上传并发布新文件。</p><label class="password-label">管理口令<input id="admin-password" v-model="adminPassword" type="password" autocomplete="current-password" required /></label><p class="login-error" role="alert">{{ loginError }}</p><button class="button button-primary" id="login-submit" :disabled="loggingIn" type="submit">{{ loggingIn ? '正在登录…' : '登录' }}</button></form></dialog>
</template>
