const MAX_UPLOAD_BYTES = 95 * 1024;
const MAX_IMAGE_DIM = 480;

const state = {
  token: null,
  settings: null,
  categories: [],
  items: [],
  orders: [],
  activeTab: 'orders',
  orderFilter: 'all',
  menuCatFilter: 'all',
  pendingImageBlob: null,
  ordersPollTimer: null,
  toastTimer: null,
};

const els = {
  loginView: document.getElementById('loginView'),
  dashboardView: document.getElementById('dashboardView'),
  loginForm: document.getElementById('loginForm'),
  adminPasswordInput: document.getElementById('adminPasswordInput'),
  loginAlert: document.getElementById('loginAlert'),
  loginBtn: document.getElementById('loginBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
  adminShopTitle: document.getElementById('adminShopTitle'),
  quickToggleStoreBtn: document.getElementById('quickToggleStoreBtn'),
  orderStatusFilter: document.getElementById('orderStatusFilter'),
  refreshOrdersBtn: document.getElementById('refreshOrdersBtn'),
  ordersContainer: document.getElementById('ordersContainer'),
  menuCategoryFilter: document.getElementById('menuCategoryFilter'),
  openAddItemBtn: document.getElementById('openAddItemBtn'),
  menuTableBody: document.getElementById('menuTableBody'),
  addCategoryForm: document.getElementById('addCategoryForm'),
  newCatName: document.getElementById('newCatName'),
  newCatEmoji: document.getElementById('newCatEmoji'),
  newCatOrder: document.getElementById('newCatOrder'),
  categoriesTableBody: document.getElementById('categoriesTableBody'),
  settingsForm: document.getElementById('settingsForm'),
  settingShopName: document.getElementById('settingShopName'),
  settingBannerText: document.getElementById('settingBannerText'),
  settingIsOpen: document.getElementById('settingIsOpen'),
  itemModal: document.getElementById('itemModal'),
  itemModalTitle: document.getElementById('itemModalTitle'),
  closeItemModalBtn: document.getElementById('closeItemModalBtn'),
  cancelItemBtn: document.getElementById('cancelItemBtn'),
  itemForm: document.getElementById('itemForm'),
  itemFormId: document.getElementById('itemFormId'),
  itemFormImageId: document.getElementById('itemFormImageId'),
  itemName: document.getElementById('itemName'),
  itemCategory: document.getElementById('itemCategory'),
  itemPrice: document.getElementById('itemPrice'),
  itemEmoji: document.getElementById('itemEmoji'),
  itemDesc: document.getElementById('itemDesc'),
  itemSortOrder: document.getElementById('itemSortOrder'),
  itemIsActive: document.getElementById('itemIsActive'),
  itemImageInput: document.getElementById('itemImageInput'),
  itemImagePreview: document.getElementById('itemImagePreview'),
  itemImageEmpty: document.getElementById('itemImageEmpty'),
  imageStatusText: document.getElementById('imageStatusText'),
  removeImageBtn: document.getElementById('removeImageBtn'),
  saveItemBtn: document.getElementById('saveItemBtn'),
  toast: document.getElementById('toast'),
};

function formatRM(cents) {
  return `RM ${(Number(cents || 0) / 100).toFixed(2)}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
}

async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token && !headers.Authorization) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers,
  });

  let data = null;
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    data = await res.json();
  }

  if (res.status === 401 && !url.endsWith('/login')) {
    showLogin('Sesi anda telah tamat. Sila log masuk semula.');
  }

  return { res, data };
}

function showLogin(errorMessage = '') {
  stopOrdersPolling();
  els.dashboardView.classList.add('hidden');
  els.loginView.classList.remove('hidden');
  if (errorMessage) {
    els.loginAlert.textContent = errorMessage;
    els.loginAlert.classList.remove('hidden');
  } else {
    els.loginAlert.classList.add('hidden');
  }
}

function showDashboard() {
  els.loginView.classList.add('hidden');
  els.dashboardView.classList.remove('hidden');
  startOrdersPolling();
}

/**
 * Compresses any uploaded image using <canvas>:
 * - Max 480px on longest side
 * - Solid white background (handles transparent PNGs cleanly)
 * - Exports JPEG stepping down quality/dimensions until < 95 KB
 */
async function compressImageFile(file) {
  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Fail gambar tidak sah.'));
      i.src = bitmapUrl;
    });

    const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
    let width = Math.max(1, Math.round(img.width * scale));
    let height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const toBlob = (w, h, quality) =>
      new Promise((resolve) => {
        canvas.width = w;
        canvas.height = h;
        // White background for PNG transparency
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
      });

    const qualities = [0.86, 0.75, 0.65, 0.55, 0.45, 0.35];
    for (let pass = 0; pass < 3; pass++) {
      for (const q of qualities) {
        const blob = await toBlob(width, height, q);
        if (blob && blob.size < MAX_UPLOAD_BYTES) {
          return blob;
        }
      }
      width = Math.max(120, Math.round(width * 0.8));
      height = Math.max(120, Math.round(height * 0.8));
    }

    const finalBlob = await toBlob(width, height, 0.3);
    if (!finalBlob || finalBlob.size >= MAX_UPLOAD_BYTES) {
      throw new Error('Gambar terlalu besar walaupun selepas dimampatkan (< 95 KB).');
    }
    return finalBlob;
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}

function renderSettingsUI() {
  if (!state.settings) return;
  const open = Number(state.settings.is_open) === 1;
  els.adminShopTitle.textContent = `Admin CMS — ${state.settings.shop_name}`;
  els.quickToggleStoreBtn.textContent = open ? '🟢 Kedai Dibuka (Klik Tutup)' : '🔴 Kedai Ditutup (Klik Buka)';
  els.quickToggleStoreBtn.className = `btn btn-sm ${open ? 'btn-success' : 'btn-danger'}`;

  els.settingShopName.value = state.settings.shop_name || '';
  els.settingBannerText.value = state.settings.banner_text || '';
  els.settingIsOpen.value = open ? '1' : '0';
}

const ORDER_STATUS_LABELS = {
  pending: '⏳ Menunggu Dapur',
  preparing: '🔥 Sedang Disediakan',
  ready: '🔔 Sedia Diambil',
  completed: '✅ Selesai',
  cancelled: '❌ Dibatalkan',
};

function renderOrders() {
  const list =
    state.orderFilter === 'all'
      ? state.orders
      : state.orders.filter((o) => o.status === state.orderFilter);

  if (list.length === 0) {
    els.ordersContainer.innerHTML =
      '<div style="grid-column:1/-1; text-align:center; padding:32px; color:#57534e;">Tiada pesanan dalam kategori ini.</div>';
    return;
  }

  els.ordersContainer.innerHTML = list
    .map((order) => {
      const typeLabel = order.order_type === 'dine_in' ? '🍽️ Makan Sini' : '🥡 Bungkus';
      const statusBadge = ORDER_STATUS_LABELS[order.status] || order.status;
      const itemsHtml = (order.items || [])
        .map(
          (line) =>
            `<div style="display:flex; justify-content:space-between;">
              <span><strong>${line.quantity}×</strong> ${escapeHtml(line.item_name)}</span>
              <span>${formatRM(line.subtotal_cents)}</span>
            </div>`
        )
        .join('');

      return `
        <article class="order-card">
          <div class="order-card-top">
            <span class="order-queue">${escapeHtml(order.queue_number)}</span>
            <span class="badge ${order.status === 'ready' ? 'badge-active' : 'badge-inactive'}">${statusBadge}</span>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:0.85rem; color:#57534e;">
            <span>${typeLabel}</span>
            <strong>${formatRM(order.total_cents)}</strong>
          </div>
          ${
            order.customer_note
              ? `<div style="font-size:0.83rem; background:#fffbeb; border:1px solid #fde68a; padding:6px 10px; border-radius:8px;">📝 ${escapeHtml(order.customer_note)}</div>`
              : ''
          }
          <div class="order-items-list">${itemsHtml}</div>
          <div class="order-actions">
            ${
              order.status === 'pending'
                ? `<button class="btn btn-primary btn-sm" data-order-id="${order.id}" data-next-status="preparing">🔥 Mula Masak</button>`
                : ''
            }
            ${
              order.status === 'preparing' || order.status === 'pending'
                ? `<button class="btn btn-success btn-sm" data-order-id="${order.id}" data-next-status="ready">🔔 Sedia Diambil</button>`
                : ''
            }
            ${
              order.status === 'ready'
                ? `<button class="btn btn-secondary btn-sm" data-order-id="${order.id}" data-next-status="completed">✅ Selesai</button>`
                : ''
            }
            ${
              order.status !== 'completed' && order.status !== 'cancelled'
                ? `<button class="btn btn-danger btn-sm" data-order-id="${order.id}" data-next-status="cancelled">Batal</button>`
                : ''
            }
          </div>
        </article>
      `;
    })
    .join('');
}

function renderCategorySelects() {
  const filterVal = els.menuCategoryFilter.value || 'all';
  els.menuCategoryFilter.innerHTML = [
    '<option value="all">Semua Kategori</option>',
    ...state.categories.map(
      (c) => `<option value="${c.id}">${escapeHtml(c.emoji)} ${escapeHtml(c.name)}</option>`
    ),
  ].join('');
  els.menuCategoryFilter.value = filterVal;

  els.itemCategory.innerHTML = state.categories
    .map((c) => `<option value="${c.id}">${escapeHtml(c.emoji)} ${escapeHtml(c.name)}</option>`)
    .join('');
}

function renderMenuTable() {
  const list =
    state.menuCatFilter === 'all'
      ? state.items
      : state.items.filter((i) => Number(i.category_id) === Number(state.menuCatFilter));

  if (list.length === 0) {
    els.menuTableBody.innerHTML =
      '<tr><td colspan="5" style="text-align:center; padding:28px; color:#57534e;">Tiada item menu ditemui.</td></tr>';
    return;
  }

  els.menuTableBody.innerHTML = list
    .map((item) => {
      const active = Number(item.is_active) === 1;
      const emoji = escapeHtml(item.emoji || '🍜');
      const thumb = item.image_id
        ? `<img src="/api/images/${item.image_id}" alt="${escapeHtml(item.name)}"
             onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden');" />
           <span class="hidden">${emoji}</span>`
        : `<span>${emoji}</span>`;

      return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:12px;">
              <div class="thumb-box">${thumb}</div>
              <div>
                <div style="font-weight:800;">${escapeHtml(item.name)}</div>
                <div style="font-size:0.8rem; color:#57534e; max-width:290px;">${escapeHtml(item.description || '')}</div>
              </div>
            </div>
          </td>
          <td>${escapeHtml(item.category_name || '-')}</td>
          <td>
            <div class="quick-price-wrap">
              <input
                type="number"
                step="0.05"
                min="0"
                class="quick-price-input"
                data-price-input="${item.id}"
                value="${(Number(item.price_cents) / 100).toFixed(2)}"
              />
              <button class="btn btn-secondary btn-sm" type="button" data-action="save-price" data-id="${item.id}">
                Tukar
              </button>
            </div>
          </td>
          <td>
            <button
              type="button"
              class="btn btn-sm ${active ? 'btn-success' : 'btn-secondary'}"
              data-action="toggle-item"
              data-id="${item.id}"
              data-active="${active ? '1' : '0'}"
            >
              ${active ? '✅ Aktif' : '⏸️ Nyahaktif'}
            </button>
          </td>
          <td>
            <div class="row-actions">
              <button class="btn btn-secondary btn-sm" type="button" data-action="edit-item" data-id="${item.id}">✏️ Edit</button>
              <button class="btn btn-secondary btn-sm" type="button" data-action="dup-item" data-id="${item.id}">📄 Salin</button>
              <button class="btn btn-danger btn-sm" type="button" data-action="del-item" data-id="${item.id}">🗑️ Padam</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderCategoriesTable() {
  if (state.categories.length === 0) {
    els.categoriesTableBody.innerHTML =
      '<tr><td colspan="5" style="text-align:center; padding:24px;">Tiada kategori.</td></tr>';
    return;
  }

  els.categoriesTableBody.innerHTML = state.categories
    .map((cat) => {
      const active = Number(cat.is_active) === 1;
      return `
        <tr>
          <td>
            <div style="display:flex; gap:8px; align-items:center;">
              <input class="form-control" style="width:60px; padding:6px 8px;" value="${escapeHtml(cat.emoji)}" data-cat-emoji="${cat.id}" />
              <input class="form-control" style="max-width:220px; padding:6px 10px;" value="${escapeHtml(cat.name)}" data-cat-name="${cat.id}" />
            </div>
          </td>
          <td>
            <input class="form-control" type="number" style="width:76px; padding:6px 8px;" value="${cat.sort_order}" data-cat-order="${cat.id}" />
          </td>
          <td><strong>${Number(cat.item_count || 0)}</strong> item</td>
          <td>
            <button
              type="button"
              class="btn btn-sm ${active ? 'btn-success' : 'btn-secondary'}"
              data-cat-action="toggle"
              data-id="${cat.id}"
            >
              ${active ? '✅ Aktif' : '⏸️ Nyahaktif'}
            </button>
          </td>
          <td>
            <div class="row-actions">
              <button class="btn btn-secondary btn-sm" type="button" data-cat-action="save" data-id="${cat.id}">💾 Simpan</button>
              <button class="btn btn-danger btn-sm" type="button" data-cat-action="delete" data-id="${cat.id}">🗑️ Padam</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

async function loadDashboard() {
  const { res, data } = await apiFetch('/api/admin/dashboard');
  if (!res.ok) {
    if (res.status === 503) {
      showLogin(data?.error || 'ADMIN_PASSWORD belum diset.');
    }
    return;
  }
  state.settings = data.settings;
  state.categories = data.categories || [];
  state.items = data.items || [];
  state.orders = data.orders || [];

  renderSettingsUI();
  renderOrders();
  renderCategorySelects();
  renderMenuTable();
  renderCategoriesTable();
}

function startOrdersPolling() {
  stopOrdersPolling();
  state.ordersPollTimer = setInterval(async () => {
    if (state.activeTab !== 'orders') return;
    const { res, data } = await apiFetch('/api/admin/orders');
    if (res.ok && data?.orders) {
      state.orders = data.orders;
      renderOrders();
    }
  }, 8000);
}

function stopOrdersPolling() {
  if (state.ordersPollTimer) {
    clearInterval(state.ordersPollTimer);
    state.ordersPollTimer = null;
  }
}

function openItemModal(item = null) {
  state.pendingImageBlob = null;
  els.itemImageInput.value = '';

  if (item) {
    els.itemModalTitle.textContent = `Edit Menu: ${item.name}`;
    els.itemFormId.value = String(item.id);
    els.itemFormImageId.value = item.image_id ? String(item.image_id) : '';
    els.itemName.value = item.name;
    els.itemCategory.value = String(item.category_id);
    els.itemPrice.value = (Number(item.price_cents) / 100).toFixed(2);
    els.itemEmoji.value = item.emoji || '🍜';
    els.itemDesc.value = item.description || '';
    els.itemSortOrder.value = String(item.sort_order || 0);
    els.itemIsActive.value = Number(item.is_active) === 1 ? '1' : '0';

    if (item.image_id) {
      els.itemImagePreview.src = `/api/images/${item.image_id}`;
      els.itemImagePreview.classList.remove('hidden');
      els.itemImageEmpty.classList.add('hidden');
      els.removeImageBtn.classList.remove('hidden');
      els.imageStatusText.textContent = `Gambar sedia ada (#${item.image_id}).`;
    } else {
      resetImagePreview();
    }
  } else {
    els.itemModalTitle.textContent = 'Tambah Item Menu Baru';
    els.itemFormId.value = '';
    els.itemFormImageId.value = '';
    els.itemName.value = '';
    els.itemPrice.value = '';
    els.itemEmoji.value = '🍜';
    els.itemDesc.value = '';
    els.itemSortOrder.value = '0';
    els.itemIsActive.value = '1';
    if (state.categories[0]) {
      els.itemCategory.value = String(state.categories[0].id);
    }
    resetImagePreview();
  }

  els.itemModal.classList.remove('hidden');
}

function resetImagePreview() {
  els.itemImagePreview.src = '';
  els.itemImagePreview.classList.add('hidden');
  els.itemImageEmpty.classList.remove('hidden');
  els.removeImageBtn.classList.add('hidden');
  els.imageStatusText.textContent = 'Tiada gambar dimuat naik (emoji akan digunakan).';
}

function bindEvents() {
  // Login
  els.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.loginBtn.disabled = true;
    els.loginAlert.classList.add('hidden');
    try {
      const { res, data } = await apiFetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: els.adminPasswordInput.value }),
      });

      if (!res.ok) {
        els.loginAlert.textContent = data?.error || 'Log masuk gagal.';
        els.loginAlert.classList.remove('hidden');
        return;
      }

      state.token = data.token;
      els.adminPasswordInput.value = '';
      showDashboard();
      await loadDashboard();
    } finally {
      els.loginBtn.disabled = false;
    }
  });

  els.logoutBtn.addEventListener('click', async () => {
    await apiFetch('/api/admin/logout', { method: 'POST' });
    state.token = null;
    showLogin('');
  });

  // Tabs
  document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      document.querySelectorAll('.admin-tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      ['orders', 'menu', 'categories', 'settings'].forEach((t) => {
        document.getElementById(`tab-${t}`).classList.toggle('hidden', t !== state.activeTab);
      });
    });
  });

  // Quick open/close store toggle
  els.quickToggleStoreBtn.addEventListener('click', async () => {
    if (!state.settings) return;
    const nextOpen = Number(state.settings.is_open) === 1 ? 0 : 1;
    const { res, data } = await apiFetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_open: nextOpen }),
    });
    if (res.ok) {
      state.settings = data;
      renderSettingsUI();
      showToast(nextOpen === 1 ? 'Kedai kini DIBUKA.' : 'Kedai kini DITUTUP.');
    }
  });

  // Orders filter & actions
  els.orderStatusFilter.addEventListener('change', (e) => {
    state.orderFilter = e.target.value;
    renderOrders();
  });

  els.refreshOrdersBtn.addEventListener('click', loadDashboard);

  els.ordersContainer.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-order-id]');
    if (!btn) return;
    const orderId = btn.dataset.orderId;
    const nextStatus = btn.dataset.nextStatus;
    const { res, data } = await apiFetch(`/api/admin/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (res.ok) {
      const idx = state.orders.findIndex((o) => o.id === data.id);
      if (idx !== -1) state.orders[idx] = data;
      renderOrders();
      showToast(`Status ${data.queue_number} dikemas kini.`);
    } else {
      showToast(data?.error || 'Gagal mengemas kini status.');
    }
  });

  // Menu filters & actions
  els.menuCategoryFilter.addEventListener('change', (e) => {
    state.menuCatFilter = e.target.value;
    renderMenuTable();
  });

  els.openAddItemBtn.addEventListener('click', () => openItemModal(null));

  els.menuTableBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const itemId = Number(btn.dataset.id);
    const item = state.items.find((i) => i.id === itemId);

    if (action === 'save-price') {
      const input = els.menuTableBody.querySelector(`input[data-price-input="${itemId}"]`);
      const price = Number(input?.value);
      if (!Number.isFinite(price) || price < 0) {
        showToast('Sila masukkan harga RM yang sah.');
        return;
      }
      const { res, data } = await apiFetch(`/api/admin/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price }),
      });
      if (res.ok) {
        showToast(`Harga ${data.name} ditukar ke ${formatRM(data.price_cents)}.`);
        await loadDashboard();
      } else {
        showToast(data?.error || 'Gagal tukar harga.');
      }
    } else if (action === 'toggle-item') {
      const nextActive = btn.dataset.active === '1' ? 0 : 1;
      const { res } = await apiFetch(`/api/admin/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: nextActive }),
      });
      if (res.ok) {
        showToast(nextActive ? 'Item diaktifkan.' : 'Item dinyahaktifkan.');
        await loadDashboard();
      }
    } else if (action === 'edit-item' && item) {
      openItemModal(item);
    } else if (action === 'dup-item') {
      const { res, data } = await apiFetch(`/api/admin/items/${itemId}/duplicate`, {
        method: 'POST',
      });
      if (res.ok) {
        showToast(`Disalin: ${data.name}`);
        await loadDashboard();
      }
    } else if (action === 'del-item') {
      if (!confirm(`Padam item "${item?.name || itemId}"?`)) return;
      const { res, data } = await apiFetch(`/api/admin/items/${itemId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        showToast('Item berjaya dipadam.');
        await loadDashboard();
      } else {
        showToast(data?.error || 'Gagal memadam item.');
      }
    }
  });

  // Image input compression
  els.itemImageInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    els.imageStatusText.textContent = 'Memampatkan gambar...';
    try {
      const compressed = await compressImageFile(file);
      state.pendingImageBlob = compressed;
      const previewUrl = URL.createObjectURL(compressed);
      els.itemImagePreview.src = previewUrl;
      els.itemImagePreview.classList.remove('hidden');
      els.itemImageEmpty.classList.add('hidden');
      els.removeImageBtn.classList.remove('hidden');
      els.imageStatusText.textContent = `Siap dimampat: ${(compressed.size / 1024).toFixed(1)} KB (< 95 KB)`;
    } catch (err) {
      state.pendingImageBlob = null;
      showToast(err.message || 'Gagal memampatkan gambar.');
      els.imageStatusText.textContent = 'Gagal memampat gambar.';
    }
  });

  els.removeImageBtn.addEventListener('click', () => {
    state.pendingImageBlob = null;
    els.itemFormImageId.value = '';
    els.itemImageInput.value = '';
    resetImagePreview();
  });

  // Modal close & save item
  els.closeItemModalBtn.addEventListener('click', () => els.itemModal.classList.add('hidden'));
  els.cancelItemBtn.addEventListener('click', () => els.itemModal.classList.add('hidden'));

  els.itemForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.saveItemBtn.disabled = true;

    try {
      let imageId = els.itemFormImageId.value ? Number(els.itemFormImageId.value) : null;

      if (state.pendingImageBlob) {
        const form = new FormData();
        form.append('file', state.pendingImageBlob, 'menu.jpg');
        const { res: upRes, data: upData } = await apiFetch('/api/admin/images', {
          method: 'POST',
          body: form,
        });
        if (!upRes.ok) {
          showToast(upData?.error || 'Gagal memuat naik gambar.');
          return;
        }
        imageId = upData.id;
      }

      const payload = {
        category_id: Number(els.itemCategory.value),
        name: els.itemName.value.trim(),
        price: Number(els.itemPrice.value),
        emoji: els.itemEmoji.value.trim() || '🍜',
        description: els.itemDesc.value.trim(),
        sort_order: Number(els.itemSortOrder.value) || 0,
        is_active: Number(els.itemIsActive.value),
        image_id: imageId,
      };

      const editId = els.itemFormId.value;
      const url = editId ? `/api/admin/items/${editId}` : '/api/admin/items';
      const method = editId ? 'PUT' : 'POST';

      const { res, data } = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        showToast(data?.error || 'Gagal menyimpan item menu.');
        return;
      }

      els.itemModal.classList.add('hidden');
      showToast(editId ? 'Menu berjaya dikemas kini.' : 'Menu baru berjaya ditambah.');
      await loadDashboard();
    } finally {
      els.saveItemBtn.disabled = false;
    }
  });

  // Categories
  els.addCategoryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { res, data } = await apiFetch('/api/admin/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: els.newCatName.value.trim(),
        emoji: els.newCatEmoji.value.trim() || '🍽️',
        sort_order: Number(els.newCatOrder.value) || 0,
      }),
    });

    if (res.ok) {
      els.newCatName.value = '';
      showToast('Kategori baru ditambah.');
      await loadDashboard();
    } else {
      showToast(data?.error || 'Gagal menambah kategori.');
    }
  });

  els.categoriesTableBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-cat-action]');
    if (!btn) return;
    const action = btn.dataset.catAction;
    const catId = Number(btn.dataset.id);

    if (action === 'toggle') {
      const { res } = await apiFetch(`/api/admin/categories/${catId}/toggle`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        showToast('Status kategori dikemas kini.');
        await loadDashboard();
      }
    } else if (action === 'save') {
      const name = els.categoriesTableBody.querySelector(`input[data-cat-name="${catId}"]`)?.value.trim();
      const emoji = els.categoriesTableBody.querySelector(`input[data-cat-emoji="${catId}"]`)?.value.trim();
      const sortOrder = Number(
        els.categoriesTableBody.querySelector(`input[data-cat-order="${catId}"]`)?.value || 0
      );
      const { res, data } = await apiFetch(`/api/admin/categories/${catId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, emoji, sort_order: sortOrder }),
      });
      if (res.ok) {
        showToast('Kategori dikemas kini.');
        await loadDashboard();
      } else {
        showToast(data?.error || 'Gagal mengemas kini kategori.');
      }
    } else if (action === 'delete') {
      const { res, data } = await apiFetch(`/api/admin/categories/${catId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        showToast('Kategori berjaya dipadam.');
        await loadDashboard();
      } else {
        // Displays 409 conflict message if category still has items
        showToast(data?.error || `Ralat (${res.status}) memadam kategori.`);
      }
    }
  });

  // Settings
  els.settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { res, data } = await apiFetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shop_name: els.settingShopName.value.trim(),
        banner_text: els.settingBannerText.value.trim(),
        is_open: Number(els.settingIsOpen.value),
      }),
    });
    if (res.ok) {
      state.settings = data;
      renderSettingsUI();
      showToast('Tetapan kedai berjaya disimpan.');
    } else {
      showToast(data?.error || 'Gagal menyimpan tetapan.');
    }
  });
}

async function init() {
  bindEvents();
  const { res, data } = await apiFetch('/api/admin/session');
  if (res.status === 503) {
    showLogin(data?.error || 'ADMIN_PASSWORD belum diset pada pelayan.');
    return;
  }
  if (!res.ok) {
    showLogin('');
    return;
  }
  showDashboard();
  await loadDashboard();
}

init();
