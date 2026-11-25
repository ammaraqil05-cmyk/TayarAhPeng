const ACTIVE_ORDER_KEY = 'ahpeng_active_order_id';

const state = {
  settings: {
    shop_name: 'Kedai Tayar Ah Peng',
    banner_text: '',
    is_open: 1,
  },
  categories: [],
  items: [],
  selectedCategoryId: 'all',
  searchQuery: '',
  orderType: 'dine_in',
  cart: new Map(), // menu_item_id -> quantity
  activeOrder: null,
  pollTimer: null,
  toastTimer: null,
};

const els = {
  shopName: document.getElementById('shopName'),
  bannerText: document.getElementById('bannerText'),
  storeStatusPill: document.getElementById('storeStatusPill'),
  storeStatusLabel: document.getElementById('storeStatusLabel'),
  closedBanner: document.getElementById('closedBanner'),
  searchInput: document.getElementById('searchInput'),
  categoryTabs: document.getElementById('categoryTabs'),
  menuGrid: document.getElementById('menuGrid'),
  cartPanel: document.getElementById('cartPanel'),
  cartItems: document.getElementById('cartItems'),
  cartTotal: document.getElementById('cartTotal'),
  customerNote: document.getElementById('customerNote'),
  clearCartBtn: document.getElementById('clearCartBtn'),
  submitOrderBtn: document.getElementById('submitOrderBtn'),
  mobileCartSummary: document.getElementById('mobileCartSummary'),
  toggleMobileCartBtn: document.getElementById('toggleMobileCartBtn'),
  activeOrderBtn: document.getElementById('activeOrderBtn'),
  activeQueueChip: document.getElementById('activeQueueChip'),
  orderModal: document.getElementById('orderModal'),
  closeModalBtn: document.getElementById('closeModalBtn'),
  newOrderBtn: document.getElementById('newOrderBtn'),
  modalQueueNumber: document.getElementById('modalQueueNumber'),
  modalOrderType: document.getElementById('modalOrderType'),
  modalLiveBadge: document.getElementById('modalLiveBadge'),
  statusSteps: document.getElementById('statusSteps'),
  modalPollHint: document.getElementById('modalPollHint'),
  modalItems: document.getElementById('modalItems'),
  modalTotal: document.getElementById('modalTotal'),
  toast: document.getElementById('toast'),
};

function formatRM(cents) {
  return `RM ${(Number(cents || 0) / 100).toFixed(2)}`;
}

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.classList.add('hidden');
  }, 3000);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isStoreOpen() {
  return Number(state.settings?.is_open) === 1;
}

function renderHeader() {
  els.shopName.textContent = state.settings.shop_name || 'Kedai Tayar Ah Peng';
  els.bannerText.textContent =
    state.settings.banner_text || 'Pesan makanan & minuman kegemaran anda terus dari skrin ini.';
  document.title = `${els.shopName.textContent} — Skrin Tempahan Layan Diri`;

  const open = isStoreOpen();
  els.storeStatusPill.className = `status-pill ${open ? 'open' : 'closed'}`;
  els.storeStatusLabel.textContent = open ? 'Kedai Dibuka' : 'Kedai Ditutup';
  els.closedBanner.classList.toggle('hidden', open);
}

function renderCategories() {
  const pills = [
    `<button type="button" class="cat-pill ${state.selectedCategoryId === 'all' ? 'active' : ''}" data-cat="all">✨ Semua Menu</button>`,
    ...state.categories.map(
      (cat) =>
        `<button type="button" class="cat-pill ${
          Number(state.selectedCategoryId) === Number(cat.id) ? 'active' : ''
        }" data-cat="${cat.id}">${escapeHtml(cat.emoji)} ${escapeHtml(cat.name)}</button>`
    ),
  ];
  els.categoryTabs.innerHTML = pills.join('');
}

function getFilteredItems() {
  const q = state.searchQuery.trim().toLowerCase();
  return state.items.filter((item) => {
    const matchCat =
      state.selectedCategoryId === 'all' ||
      Number(item.category_id) === Number(state.selectedCategoryId);
    const matchSearch =
      !q ||
      item.name.toLowerCase().includes(q) ||
      (item.description && item.description.toLowerCase().includes(q));
    return matchCat && matchSearch;
  });
}

function renderMenu() {
  const filtered = getFilteredItems();
  const catMap = new Map(state.categories.map((c) => [Number(c.id), c]));
  const open = isStoreOpen();

  if (filtered.length === 0) {
    els.menuGrid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:42px 16px; background:#fff; border-radius:16px; border:1px solid #e7e2da; color:#57534e;">Tiada menu dijumpai untuk carian atau kategori ini.</div>`;
    return;
  }

  els.menuGrid.innerHTML = filtered
    .map((item) => {
      const qty = state.cart.get(item.id) || 0;
      const cat = catMap.get(Number(item.category_id));
      const catTag = cat ? `${escapeHtml(cat.emoji)} ${escapeHtml(cat.name)}` : '';
      const emoji = escapeHtml(item.emoji || '🍜');

      // Image with automatic emoji fallback if loading fails or no image_id
      const mediaHtml = item.image_id
        ? `<img src="/api/images/${item.image_id}" alt="${escapeHtml(item.name)}" loading="lazy"
             onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden');" />
           <div class="menu-emoji-fallback hidden">${emoji}</div>`
        : `<div class="menu-emoji-fallback">${emoji}</div>`;

      const actionHtml =
        qty > 0
          ? `<div class="qty-stepper">
               <button type="button" data-action="dec" data-id="${item.id}" ${!open ? 'disabled' : ''}>−</button>
               <span>${qty}</span>
               <button type="button" data-action="inc" data-id="${item.id}" ${!open ? 'disabled' : ''}>+</button>
             </div>`
          : `<button type="button" class="btn btn-primary btn-sm" data-action="inc" data-id="${item.id}" ${
              !open ? 'disabled' : ''
            }>+ Tambah</button>`;

      return `
        <article class="menu-card">
          <div class="menu-media">
            ${mediaHtml}
            ${catTag ? `<span class="menu-cat-tag">${catTag}</span>` : ''}
          </div>
          <div class="menu-body">
            <h3 class="menu-name">${escapeHtml(item.name)}</h3>
            <p class="menu-desc">${escapeHtml(item.description || '')}</p>
            <div class="menu-footer">
              <span class="menu-price">${formatRM(item.price_cents)}</span>
              ${actionHtml}
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderCart() {
  const itemMap = new Map(state.items.map((i) => [i.id, i]));
  const open = isStoreOpen();
  let totalCount = 0;
  let totalCents = 0;
  const rows = [];

  for (const [itemId, qty] of state.cart.entries()) {
    const item = itemMap.get(itemId);
    if (!item || qty <= 0) continue;
    totalCount += qty;
    const sub = item.price_cents * qty;
    totalCents += sub;

    rows.push(`
      <div class="cart-item-row">
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(item.emoji || '🍜')} ${escapeHtml(item.name)}</div>
          <div class="cart-item-sub">${formatRM(item.price_cents)} × ${qty} = <strong>${formatRM(sub)}</strong></div>
        </div>
        <div class="qty-stepper">
          <button type="button" data-action="dec" data-id="${item.id}">−</button>
          <span>${qty}</span>
          <button type="button" data-action="inc" data-id="${item.id}">+</button>
        </div>
      </div>
    `);
  }

  if (rows.length === 0) {
    els.cartItems.innerHTML =
      '<div class="cart-empty">Belum ada item dipilih. Pilih menu di sebelah untuk mula memesan.</div>';
  } else {
    els.cartItems.innerHTML = rows.join('');
  }

  els.cartTotal.textContent = formatRM(totalCents);
  els.mobileCartSummary.textContent = `${totalCount} item · ${formatRM(totalCents)}`;
  els.submitOrderBtn.disabled = !open || totalCount === 0;
}

function adjustCart(itemId, delta) {
  if (!isStoreOpen() && delta > 0) {
    showToast('Maaf, kedai sedang ditutup.');
    return;
  }
  const current = state.cart.get(itemId) || 0;
  const next = Math.max(0, Math.min(99, current + delta));
  if (next === 0) {
    state.cart.delete(itemId);
  } else {
    state.cart.set(itemId, next);
  }
  renderMenu();
  renderCart();
}

const STATUS_META = {
  pending: { label: '⏳ Menunggu Dapur', cls: 'live-pending', stepIndex: 0 },
  preparing: { label: '🔥 Sedang Disediakan', cls: 'live-preparing', stepIndex: 1 },
  ready: { label: '🔔 Sedia Diambil!', cls: 'live-ready', stepIndex: 2 },
  completed: { label: '✅ Selesai Diambil', cls: 'live-completed', stepIndex: 3 },
  cancelled: { label: '❌ Pesanan Dibatalkan', cls: 'live-cancelled', stepIndex: -1 },
};

function renderOrderModal(order) {
  if (!order) return;
  state.activeOrder = order;
  localStorage.setItem(ACTIVE_ORDER_KEY, String(order.id));

  els.activeQueueChip.textContent = order.queue_number;
  els.activeOrderBtn.classList.remove('hidden');

  els.modalQueueNumber.textContent = order.queue_number;
  els.modalOrderType.textContent =
    order.order_type === 'dine_in' ? '🍽️ Makan Sini' : '🥡 Bungkus';

  const meta = STATUS_META[order.status] || STATUS_META.pending;
  els.modalLiveBadge.className = `live-badge ${meta.cls}`;
  els.modalLiveBadge.textContent = meta.label;

  const stepBoxes = els.statusSteps.querySelectorAll('.step-box');
  stepBoxes.forEach((box, idx) => {
    box.classList.remove('active', 'done');
    if (meta.stepIndex >= 0) {
      if (idx < meta.stepIndex) box.classList.add('done');
      else if (idx === meta.stepIndex) box.classList.add('active');
    }
  });

  const terminal = order.status === 'completed' || order.status === 'cancelled';
  els.modalPollHint.textContent = terminal
    ? 'Pesanan ini telah selesai. Terima kasih kerana mengunjungi Kedai Tayar Ah Peng!'
    : 'Status dikemas kini secara langsung setiap 4 saat.';

  els.modalItems.innerHTML = (order.items || [])
    .map(
      (line) => `
      <div class="ticket-line">
        <span>${line.quantity}× ${escapeHtml(line.item_name)}</span>
        <strong>${formatRM(line.subtotal_cents)}</strong>
      </div>`
    )
    .join('');

  els.modalTotal.textContent = formatRM(order.total_cents);
}

function stopOrderPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function fetchOrderStatus(orderId) {
  try {
    const res = await fetch(`/api/orders/${orderId}`, { cache: 'no-store' });
    if (!res.ok) {
      if (res.status === 404) {
        localStorage.removeItem(ACTIVE_ORDER_KEY);
        stopOrderPolling();
      }
      return null;
    }
    const order = await res.json();
    renderOrderModal(order);
    if (order.status === 'completed' || order.status === 'cancelled') {
      stopOrderPolling();
    }
    return order;
  } catch {
    return null;
  }
}

function startOrderPolling(orderId) {
  stopOrderPolling();
  state.pollTimer = setInterval(() => {
    fetchOrderStatus(orderId);
  }, 4000);
}

async function submitOrder() {
  if (state.cart.size === 0) return;

  const items = Array.from(state.cart.entries()).map(([menu_item_id, quantity]) => ({
    menu_item_id,
    quantity,
  }));

  els.submitOrderBtn.disabled = true;
  els.submitOrderBtn.textContent = 'Menghantar pesanan...';

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_type: state.orderType,
        customer_note: els.customerNote.value.trim(),
        items,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Gagal menghantar pesanan.');
      await loadKioskData();
      return;
    }

    state.cart.clear();
    els.customerNote.value = '';
    els.cartPanel.classList.remove('mobile-open');
    renderMenu();
    renderCart();

    renderOrderModal(data);
    els.orderModal.classList.remove('hidden');
    startOrderPolling(data.id);
    showToast(`Pesanan berjaya! Nombor giliran anda: ${data.queue_number}`);
  } catch {
    showToast('Ralat rangkaian semasa menghantar pesanan.');
  } finally {
    els.submitOrderBtn.textContent = '✅ Hantar Pesanan Sekarang';
    renderCart();
  }
}

async function loadKioskData() {
  try {
    const res = await fetch('/api/kiosk', { cache: 'no-store' });
    if (!res.ok) throw new Error('Gagal memuatkan menu');
    const data = await res.json();
    state.settings = data.settings || state.settings;
    state.categories = data.categories || [];
    state.items = data.items || [];

    // Remove cart items that were deactivated or deleted
    const activeIds = new Set(state.items.map((i) => i.id));
    for (const id of state.cart.keys()) {
      if (!activeIds.has(id)) state.cart.delete(id);
    }

    renderHeader();
    renderCategories();
    renderMenu();
    renderCart();
  } catch {
    showToast('Tidak dapat memuatkan data menu. Sila muat semula halaman.');
  }
}

function bindEvents() {
  els.categoryTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-pill');
    if (!btn) return;
    state.selectedCategoryId = btn.dataset.cat;
    renderCategories();
    renderMenu();
  });

  els.searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderMenu();
  });

  const handleStepperClick = (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const delta = btn.dataset.action === 'inc' ? 1 : -1;
    adjustCart(id, delta);
  };

  els.menuGrid.addEventListener('click', handleStepperClick);
  els.cartItems.addEventListener('click', handleStepperClick);

  document.querySelectorAll('.order-type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.orderType = btn.dataset.orderType;
      document.querySelectorAll('.order-type-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
    });
  });

  els.clearCartBtn.addEventListener('click', () => {
    state.cart.clear();
    renderMenu();
    renderCart();
  });

  els.submitOrderBtn.addEventListener('click', submitOrder);

  els.toggleMobileCartBtn.addEventListener('click', () => {
    els.cartPanel.classList.toggle('mobile-open');
  });

  els.activeOrderBtn.addEventListener('click', () => {
    if (state.activeOrder) {
      renderOrderModal(state.activeOrder);
      els.orderModal.classList.remove('hidden');
      if (!['completed', 'cancelled'].includes(state.activeOrder.status)) {
        startOrderPolling(state.activeOrder.id);
      }
    }
  });

  els.closeModalBtn.addEventListener('click', () => {
    els.orderModal.classList.add('hidden');
  });

  els.newOrderBtn.addEventListener('click', () => {
    els.orderModal.classList.add('hidden');
  });
}

async function init() {
  bindEvents();
  await loadKioskData();

  const savedOrderId = localStorage.getItem(ACTIVE_ORDER_KEY);
  if (savedOrderId) {
    const order = await fetchOrderStatus(Number(savedOrderId));
    if (order && !['completed', 'cancelled'].includes(order.status)) {
      startOrderPolling(order.id);
    }
  }

  // Refresh kiosk menu & open/closed status periodically every 20s
  setInterval(loadKioskData, 20000);
}

init();
