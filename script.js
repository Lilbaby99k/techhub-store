'use strict';
/* =====================================================================
   TechHub customer storefront. Vanilla JS + Supabase.
   Only the PUBLIC anon key belongs here. Security is enforced by RLS and
   the place_order() RPC, never by this file.
   ===================================================================== */
// CONFIG (Supabase URL, anon key, page size) is loaded from config.js
const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#f0f0f0"/><text x="100" y="108" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#999">No image</text></svg>');
const debounce = (fn, ms = 350) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const money = n => new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency || 'NGN', maximumFractionDigits: 0 }).format(n || 0);
const one = v => (Array.isArray(v) ? v[0] : v) || null;

function toast(msg, isErr) {
  const el = Object.assign(document.createElement('div'), { className: 'toast' + (isErr ? ' err' : ''), textContent: msg });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3500);
}

const store = {
  get() { try { return JSON.parse(localStorage.getItem('cart')) || []; } catch { return []; } },
  set(v) { try { localStorage.setItem('cart', JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const state = { user: null, profile: null, settings: {}, cats: [], brands: [], wish: new Set(), cart: store.get(), channel: null };

/* ---------- product presentation ---------- */
const priceOf = p => Number(p.discount_price ?? p.price);
const stockOf = p => one(p.inventory)?.quantity ?? 0;
const imgOf = p => [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)[0]?.url || PLACEHOLDER;
const pct = p => (p.discount_price ? Math.round((1 - p.discount_price / p.price) * 100) : 0);
const stars = r => `<span class="stars" aria-label="${r} out of 5">${'★'.repeat(Math.round(r))}${'☆'.repeat(5 - Math.round(r))}</span>`;

function stockLabel(p) {
  const q = stockOf(p), lim = one(p.inventory)?.low_stock_threshold ?? 5;
  if (q <= 0) return '<span class="stock-out">Out of Stock</span>';
  return q <= lim ? `<span class="stock-low">Only ${q} left</span>` : '<span class="stock-ok">In Stock</span>';
}

function card(p) {
  const out = stockOf(p) <= 0;
  return `<article class="card">
    ${pct(p) ? `<span class="tag">-${pct(p)}%</span>` : ''}
    <button class="wish ${state.wish.has(p.id) ? 'on' : ''}" data-action="wish" data-id="${p.id}" aria-label="Toggle wishlist">♥</button>
    <a class="pic" href="#/product/${esc(p.slug)}"><img src="${esc(imgOf(p))}" alt="${esc(p.name)}" loading="lazy"></a>
    <div class="body">
      <span class="brand">${esc(p.brands?.name || '')}</span>
      <a class="name" href="#/product/${esc(p.slug)}">${esc(p.name)}</a>
      ${p.review_count ? `<div>${stars(p.rating_avg)}<small class="brand">(${p.review_count})</small></div>` : ''}
      <div class="prow"><span class="price">${money(priceOf(p))}</span>${p.discount_price ? `<span class="old">${money(p.price)}</span>` : ''}</div>
    </div>
    <div class="foot"><button class="btn pri sm" data-action="add" data-id="${p.id}" ${out ? 'disabled' : ''}>${out ? 'Out of Stock' : 'Add to Cart'}</button></div>
  </article>`;
}

const PRODUCT_SELECT = '*, brands(name), product_images(url,sort_order), inventory(quantity,low_stock_threshold)';

const stateBox = (title, text, btn) => `<div class="state"><h2>${title}</h2><p>${text}</p>${btn || ''}</div>`;
const errorBox = msg => stateBox('Something went wrong', esc(msg || 'Please try again.'), '<button class="btn" data-action="retry">Try again</button>');
const skeleton = (n = 8) => `<div class="grid">${'<div class="skel"></div>'.repeat(n)}</div>`;

/* ---------- data access ---------- */
async function fetchProducts({ cat, brand, min, max, stock, rating, q, sort = 'featured', f, page = 1, size = CONFIG.PAGE_SIZE }) {
  let sel = stock ? PRODUCT_SELECT.replace('inventory(', 'inventory!inner(') : PRODUCT_SELECT;
  let query = db.from('products').select(sel, { count: 'exact' }).eq('is_active', true);
  if (cat) query = query.eq('category_id', cat);
  if (brand) query = query.eq('brand_id', brand);
  if (min) query = query.gte('price', min);
  if (max) query = query.lte('price', max);
  if (rating) query = query.gte('rating_avg', rating);
  if (stock) query = query.gt('inventory.quantity', 0);
  if (f === 'deals') query = query.not('discount_price', 'is', null);
  if (f === 'new') query = query.eq('is_new_arrival', true);
  if (f === 'best') { query = query.eq('is_best_seller', true); sort = sort === 'featured' ? 'best' : sort; }
  if (q) {
    const term = q.replace(/[,()%*]/g, ' ').trim();
    const matches = state.cats.filter(c => c.name.toLowerCase().includes(term.toLowerCase())).map(c => `category_id.eq.${c.id}`);
    const brandHits = state.brands.filter(b => b.name.toLowerCase().includes(term.toLowerCase())).map(b => `brand_id.eq.${b.id}`);
    query = query.or([`name.ilike.%${term}%`, `sku.ilike.%${term}%`, `description.ilike.%${term}%`, ...matches, ...brandHits].join(','));
  }
  const orders = {
    featured: [['is_featured', false], ['created_at', false]], new: [['created_at', false]], low: [['price', true]],
    high: [['price', false]], rated: [['rating_avg', false]], best: [['sold_count', false]],
  }[sort] || [['created_at', false]];
  orders.forEach(([col, asc]) => { query = query.order(col, { ascending: asc }); });
  const from = (page - 1) * size;
  const { data, error, count } = await query.range(from, from + size - 1);
  if (error) throw error;
  return { data, count };
}

async function loadWishlist() {
  state.wish = new Set();
  if (state.user) {
    const { data } = await db.from('wishlist_items').select('product_id');
    (data || []).forEach(r => state.wish.add(r.product_id));
  }
  $('#wishCount').textContent = state.wish.size;
}

/* ---------- cart (browser holds ids + qty only; prices are always re-read) ---------- */
function saveCart() {
  store.set(state.cart);
  $('#cartCount').textContent = state.cart.reduce((n, i) => n + i.qty, 0);
}
function cartAdd(id, qty = 1) {
  const line = state.cart.find(i => i.id === id);
  line ? (line.qty = Math.min(99, line.qty + qty)) : state.cart.push({ id, qty });
  saveCart();
}

/* ---------- router ---------- */
const routes = {};
function parseHash() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  return { path, params: Object.fromEntries(new URLSearchParams(qs || '')) };
}
let lastRender = 0;
async function render() {
  const { path, params } = parseHash();
  const token = ++lastRender;
  const [, name, arg] = path.split('/');
  const handler = routes[name || 'home'] || routes.notfound;
  if (state.needs2fa && ['account', 'order', 'checkout', 'wishlist', 'confirmed', 'verify'].includes(name)) { sessionStorage.setItem('after', location.hash); return go('#/verify2fa'); }
  app.innerHTML = skeleton(4);
  window.scrollTo(0, 0);
  try {
    const html = await handler(arg, params);
    if (token === lastRender && html != null) app.innerHTML = html;
    if (token === lastRender) bindPage(name || 'home', arg, params);
  } catch (e) {
    console.error(e);
    if (token === lastRender) app.innerHTML = errorBox(e.message);
  }
  $('#mainnav').classList.remove('open');
}
const go = (path) => { location.hash = path; };

/* ---------- pages ---------- */
routes.home = async () => {
  const [feat, deals, fresh, best] = await Promise.all([
    fetchProducts({ size: 8 }), fetchProducts({ f: 'deals', size: 4 }),
    fetchProducts({ f: 'new', size: 4 }), fetchProducts({ f: 'best', size: 4 }),
  ]);
  const sec = (title, link, res) => res.data.length ? `<section class="section"><div class="sec-head"><h2>${title}</h2><a href="#/shop${link}">View all</a></div><div class="grid">${res.data.map(card).join('')}</div></section>` : '';
  const heroImgs = feat.data.slice(0, 4).map(p => `<img src="${esc(imgOf(p))}" alt="">`).join('');
  return `<section class="hero">
      <div><h1>Upgrade your tech</h1><p>Discover the latest smartphones, laptops, gaming gear and smart gadgets.</p>
      <div class="cta"><a class="btn pri" href="#/shop">Shop Now</a><a class="btn ghost" href="#/shop?f=deals">Explore Deals</a></div></div>
      ${heroImgs ? `<div class="hero-art">${heroImgs}</div>` : ''}
    </section>
    <section class="trust"><div><b>Secure payment</b>Pay online with Paystack</div><div><b>Pay on delivery</b>Pay when your order arrives</div><div><b>Fast delivery</b>Lagos in ${esc(POLICY.deliveryLagos)}</div><div><b>Easy returns</b>${esc(POLICY.returnDays)}-day returns on faulty items</div></section>
    <section class="section"><h2>Shop by category</h2><div class="cats">${state.cats.map(c => `<a class="cat" href="#/shop?cat=${c.id}">${c.image_url ? `<img src="${esc(c.image_url)}" alt="">` : ''}${esc(c.name)}</a>`).join('')}</div></section>
    ${sec('Featured products', '', feat)}${sec('Hot deals', '?f=deals', deals)}${sec('New arrivals', '?f=new', fresh)}${sec('Best sellers', '?f=best', best)}
    ${!feat.data.length ? stateBox('No products yet', 'Products added by the store will appear here.') : ''}`;
};

routes.shop = async (_, p) => {
  const page = Math.max(1, +p.page || 1);
  const { data, count } = await fetchProducts({ ...p, page, min: +p.min || 0, max: +p.max || 0, rating: +p.rating || 0 });
  const pages = Math.ceil(count / CONFIG.PAGE_SIZE);
  const opt = (v, l, sel) => `<option value="${esc(v)}" ${String(sel) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
  const sorts = [['featured', 'Featured'], ['new', 'Newest'], ['low', 'Price: Low to High'], ['high', 'Price: High to Low'], ['rated', 'Highest Rated'], ['best', 'Best Selling']];
  return `<div class="shop">
    <form class="panel filters" id="filters">
      <label for="fq">Search</label><input id="fq" name="q" type="search" value="${esc(p.q || '')}">
      <label for="fc">Category</label><select id="fc" name="cat">${opt('', 'All categories', p.cat)}${state.cats.map(c => opt(c.id, c.name, p.cat)).join('')}</select>
      <label for="fb">Brand</label><select id="fb" name="brand">${opt('', 'All brands', p.brand)}${state.brands.map(b => opt(b.id, b.name, p.brand)).join('')}</select>
      <label>Price</label><div class="row2"><input name="min" type="number" min="0" placeholder="Min" value="${esc(p.min || '')}" aria-label="Minimum price"><input name="max" type="number" min="0" placeholder="Max" value="${esc(p.max || '')}" aria-label="Maximum price"></div>
      <label for="fr">Rating</label><select id="fr" name="rating">${opt('', 'Any rating', p.rating)}${[4, 3, 2].map(n => opt(n, `${n}★ & up`, p.rating)).join('')}</select>
      <label class="check"><input type="checkbox" name="stock" value="1" ${p.stock ? 'checked' : ''}> In stock only</label>
      <input type="hidden" name="f" value="${esc(p.f || '')}">
      <button class="btn pri sm" style="width:100%;margin-top:12px">Apply filters</button>
      <a class="btn ghost sm" style="width:100%;margin-top:8px" href="#/shop">Clear all</a>
    </form>
    <section>
      <div class="toolbar"><strong>${count} product${count === 1 ? '' : 's'}</strong><button type="button" class="btn ghost sm fbtn" data-action="filters" aria-controls="filters">Filters</button>
        <select id="sort" aria-label="Sort products">${sorts.map(([v, l]) => opt(v, l, p.sort || 'featured')).join('')}</select></div>
      ${data.length ? `<div class="grid">${data.map(card).join('')}</div>` : stateBox('No products found', 'Try a different search or clear some filters.', '<a class="btn" href="#/shop">Clear filters</a>')}
      ${pages > 1 ? `<div class="pager"><button class="btn ghost sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button><span style="align-self:center">Page ${page} of ${pages}</span><button class="btn ghost sm" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next</button></div>` : ''}
    </section></div>`;
};

routes.product = async (slug) => {
  const { data: p, error } = await db.from('products')
    .select(PRODUCT_SELECT + ', categories(name), product_specs(spec_key,spec_value,sort_order)').eq('slug', slug).eq('is_active', true).maybeSingle();
  if (error) throw error;
  if (!p) return stateBox('Product not found', 'It may have been removed.', '<a class="btn" href="#/shop">Back to shop</a>');
  try { const v = (JSON.parse(localStorage.getItem('viewed')) || []).filter(x => x !== p.id); v.unshift(p.id); localStorage.setItem('viewed', JSON.stringify(v.slice(0, 12))); } catch { /* storage unavailable */ }
  const { data: reviews } = await db.from('public_reviews').select('rating,comment,created_at,reviewer').eq('product_id', p.id).order('created_at', { ascending: false }).limit(20);
  let canReview = false, mine = null;
  if (state.user) { // only customers who received this product may review it (also enforced by the database)
    const [ok, own] = await Promise.all([db.rpc('has_purchased', { p_product: p.id }), db.from('reviews').select('rating,comment').eq('product_id', p.id).eq('user_id', state.user.id).maybeSingle()]);
    canReview = !!ok.data; mine = own.data;
  }
  const imgs = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order);
  const out = stockOf(p) <= 0;
  return `<div class="pd">
    <div class="gallery"><div class="main"><img id="mainImg" src="${esc(imgs[0]?.url || PLACEHOLDER)}" alt="${esc(p.name)}"></div>
      <div class="thumbs">${imgs.map((i, n) => `<button class="${n ? '' : 'on'}" data-thumb="${esc(i.url)}" aria-label="Image ${n + 1}"><img src="${esc(i.url)}" alt=""></button>`).join('')}</div></div>
    <div><span class="brand">${esc(p.brands?.name || '')} · ${esc(p.categories?.name || '')}</span><h1>${esc(p.name)}</h1>
      <div style="margin:8px 0">${p.review_count ? `${stars(p.rating_avg)} <small class="brand">${p.rating_avg} (${p.review_count} reviews)</small>` : '<small class="brand">No reviews yet</small>'}</div>
      <div class="prow"><span class="price">${money(priceOf(p))}</span>${p.discount_price ? `<span class="old">${money(p.price)}</span> <span class="tag" style="position:static;display:inline-block">-${pct(p)}%</span>` : ''}</div>
      <p style="margin:8px 0">${stockLabel(p)}</p>
      <div class="pd-actions">
        <div class="qty"><button data-q="-1" aria-label="Decrease">−</button><span id="pq">1</span><button data-q="1" aria-label="Increase">+</button></div>
        <button class="btn pri" data-action="add" data-id="${p.id}" data-pq ${out ? 'disabled' : ''}>Add to Cart</button>
        <button class="btn" data-action="buy" data-id="${p.id}" data-pq ${out ? 'disabled' : ''}>Buy Now</button>
        <button class="btn ghost wishbtn" data-action="wish" data-id="${p.id}">${state.wish.has(p.id) ? 'Remove from wishlist' : 'Add to wishlist'}</button>
      </div>
      <p style="white-space:pre-line">${esc(p.description)}</p></div></div>
    ${p.product_specs?.length ? `<section class="section panel" style="margin-top:28px"><h2>Specifications</h2><table class="specs">${[...p.product_specs].sort((a, b) => a.sort_order - b.sort_order).map(s => `<tr><th>${esc(s.spec_key)}</th><td>${esc(s.spec_value)}</td></tr>`).join('')}</table></section>` : ''}
    <section class="section panel" id="reviews"><h2>Customer reviews</h2>${reviewForm(p.id, canReview, mine)}${reviews?.length ? reviews.map(r => `<div class="review">${stars(r.rating)} <b>${esc(r.reviewer)}</b> <small class="brand">Verified purchase · ${new Date(r.created_at).toLocaleDateString()}</small><p>${esc(r.comment || '')}</p></div>`).join('') : '<p class="brand">No reviews yet.</p>'}</section>`;
};

function reviewForm(pid, can, mine) {
  if (!state.user) return '<p class="brand">Sign in to review products you have bought.</p>';
  if (!can) return '<p class="brand">Only customers who have received this product can review it.</p>';
  return `<form id="reviewForm" class="rform" data-pid="${pid}" novalidate><div id="rvMsg"></div><strong>${mine ? 'Edit your review' : 'Rate this product'}</strong>
    <div class="rate" id="rate">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-v="${n}" class="${n <= (mine?.rating || 0) ? 'on' : ''}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
    <input type="hidden" name="rating" value="${mine?.rating || ''}">
    <textarea name="comment" rows="3" maxlength="1000" placeholder="What did you like or dislike? (optional)">${esc(mine?.comment || '')}</textarea>
    <button class="btn pri sm">${mine ? 'Update review' : 'Submit review'}</button></form>`;
}
async function submitReview(e) {
  e.preventDefault();
  const f = e.target, rating = +f.elements.rating.value;
  if (!(rating >= 1 && rating <= 5)) return showMsg('#rvMsg', 'Please choose a star rating.');
  const { error } = await db.from('reviews').upsert({ product_id: f.dataset.pid, user_id: state.user.id, rating, comment: f.elements.comment.value.trim() || null }, { onConflict: 'product_id,user_id' });
  if (error) return showMsg('#rvMsg', 'Could not save your review: ' + error.message);
  toast('Thank you for your review'); render();
}

/* Fetch fresh prices/stock for the cart. Display only; the server recalculates on checkout. */
async function cartLines() {
  if (!state.cart.length) return [];
  const { data, error } = await db.from('products').select(PRODUCT_SELECT).in('id', state.cart.map(i => i.id)).eq('is_active', true);
  if (error) throw error;
  const lines = data.map(p => ({ p, qty: Math.min(state.cart.find(i => i.id === p.id).qty, Math.max(stockOf(p), 1)) }));
  state.cart = lines.map(l => ({ id: l.p.id, qty: l.qty })); // drop removed products
  saveCart();
  return lines;
}
function totals(lines) {
  const list = lines.reduce((n, l) => n + l.p.price * l.qty, 0);
  const sub = lines.reduce((n, l) => n + priceOf(l.p) * l.qty, 0);
  const s = state.settings, free = +s.free_shipping_threshold || 0;
  const ship = !lines.length ? 0 : (free > 0 && sub >= free ? 0 : +s.shipping_flat_fee || 0);
  const tax = Math.round(sub * (+s.tax_rate_percent || 0)) / 100;
  return { list, sub, disc: list - sub, ship, tax, total: sub + ship + tax };
}
const summary = t => `<div class="sum"><div><span>Subtotal</span><span>${money(t.list)}</span></div>${t.disc ? `<div><span>Discount</span><span>-${money(t.disc)}</span></div>` : ''}<div><span>Delivery</span><span>${t.ship ? money(t.ship) : 'Free'}</span></div>${t.tax ? `<div><span>Tax</span><span>${money(t.tax)}</span></div>` : ''}<div class="tot"><span>Total</span><span>${money(t.total)}</span></div></div>`;

routes.cart = async () => {
  const lines = await cartLines();
  if (!lines.length) return stateBox('Your cart is empty', 'Add products to start your order.', '<a class="btn pri" href="#/shop">Continue shopping</a>');
  const t = totals(lines);
  return `<h1 style="margin-bottom:16px">Shopping cart</h1><div class="two"><div class="panel">${lines.map(({ p, qty }) => `<div class="line">
      <img src="${esc(imgOf(p))}" alt="${esc(p.name)}"><div><a href="#/product/${esc(p.slug)}"><strong>${esc(p.name)}</strong></a><div>${money(priceOf(p))} ${stockLabel(p)}</div><button class="link" data-action="remove" data-id="${p.id}">Remove</button></div>
      <div class="qty"><button data-action="qty" data-id="${p.id}" data-d="-1" aria-label="Decrease">−</button><span>${qty}</span><button data-action="qty" data-id="${p.id}" data-d="1" aria-label="Increase" ${qty >= stockOf(p) ? 'disabled' : ''}>+</button></div></div>`).join('')}</div>
    <aside class="panel"><h2>Order summary</h2>${summary(t)}<a class="btn pri" style="width:100%;margin-top:12px" href="#/checkout" ${lines.some(l => stockOf(l.p) <= 0) ? 'aria-disabled="true"' : ''}>Proceed to checkout</a></aside></div>`;
};

let checkoutAddrs = [];
routes.checkout = async () => {
  if (!state.user) { sessionStorage.setItem('after', '#/checkout'); return go('#/login'), null; }
  const lines = await cartLines();
  if (!lines.length) return go('#/cart'), null;
  const bad = lines.find(l => stockOf(l.p) < l.qty);
  if (bad) return stateBox('Stock changed', `${esc(bad.p.name)} is no longer available in the quantity you chose.`, '<a class="btn" href="#/cart">Review cart</a>');
  const { data: addrs } = await db.from('addresses').select('*').order('is_default', { ascending: false });
  checkoutAddrs = addrs || []; const da = checkoutAddrs[0];
  const pr = state.profile || {}, f = (id, label, val = '', type = 'text', extra = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" value="${esc(val)}" required ${extra}></div>`;
  const t = totals(lines), max = +state.settings.cod_max_amount || 0;
  const codOn = state.settings.cod_enabled !== false, codOk = codOn && (!max || t.total <= max);
  return `<h1 style="margin-bottom:16px">Checkout</h1><div class="two">
    <form class="panel form wide" id="checkoutForm" novalidate><div id="ckMsg"></div>
      ${checkoutAddrs.length ? `<div class="field"><label for="addrPick">Deliver to</label><select id="addrPick">${checkoutAddrs.map(a => `<option value="${a.id}">${esc(a.label)} · ${esc(a.address_line)}, ${esc(a.city)}</option>`).join('')}<option value="">A new address</option></select></div>` : ''}
      <div class="row2">${f('name', 'Full name', da?.recipient ?? pr.full_name)}${f('phone', 'Phone number', da?.phone ?? pr.phone, 'tel')}</div>
      ${f('email', 'Email', state.user.email, 'email')}${f('address', 'Delivery address', da?.address_line)}
      <div class="row2">${f('city', 'City', da?.city)}${f('state', 'State', da?.state)}</div>${f('country', 'Country', da?.country ?? 'Nigeria')}
      <div class="field"><label for="notes">Delivery instructions (optional)</label><textarea id="notes" name="notes" rows="3" maxlength="500"></textarea></div>
      <div style="margin:0 0 14px"><label class="check"><input type="checkbox" name="save_addr" ${checkoutAddrs.length ? '' : 'checked'}> Save this address for next time</label></div>
      <div class="field"><label>Payment method</label>
        <label class="check"><input type="radio" name="payment" value="paystack" checked> Pay now online (card, bank transfer or USSD)</label>
        ${codOn ? `<label class="check"><input type="radio" name="payment" value="cod" ${codOk ? '' : 'disabled'}> Pay on delivery</label>${codOk ? '' : `<small class="brand">Pay on delivery is available for orders up to ${money(max)}.</small>`}` : ''}</div>
      <button class="btn pri" id="placeBtn" style="width:100%">Place order</button></form>
    <aside class="panel"><h2>Your items</h2>${lines.map(({ p, qty }) => `<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0"><span>${qty} × ${esc(p.name)}</span><span>${money(priceOf(p) * qty)}</span></div>`).join('')}<hr style="margin:10px 0;border:0;border-top:1px solid var(--line)">${summary(totals(lines))}<p class="brand" style="font-size:12px;margin-top:8px">The final total is confirmed securely by the store when you place the order.</p></aside></div>`;
};

routes.confirmed = async (id) => {
  const { data: o, error } = await db.from('orders').select('*, order_items(*)').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!o) return stateBox('Order not found', '', '<a class="btn" href="#/account/orders">My orders</a>');
  return stateBox('Order placed', `Thank you! Your order number is <strong>${esc(o.order_number)}</strong>. Total: ${money(o.total)}. ${o.payment_method === 'cod' ? 'You will pay when your order is delivered.' : 'Payment status: ' + esc(o.payment_status) + '.'}`, `<a class="btn pri" href="#/order/${o.id}">Track your order</a>`);
};

/* Customer returns from Paystack. The server re-checks the payment; the URL alone proves nothing. */
routes.verify = async (ref) => {
  if (!state.user) { sessionStorage.setItem('after', location.hash); return go('#/login'), null; }
  const { data, error } = await db.functions.invoke('verify-payment', { body: { reference: ref } });
  if (error) throw new Error('We could not confirm your payment yet. If you were charged, it will be confirmed shortly. Check My orders.');
  if (data.status === 'paid') return go('#/confirmed/' + data.order_id), null;
  return stateBox(data.status === 'pending' ? 'Payment pending' : 'Payment not completed',
    'Your order is saved but not yet paid. You can try again from your account.', '<a class="btn pri" href="#/account/orders">My orders</a>');
};

routes.wishlist = async () => {
  if (!state.user) { sessionStorage.setItem('after', '#/wishlist'); return go('#/login'), null; }
  const { data, error } = await db.from('wishlist_items').select(`products(${PRODUCT_SELECT})`).order('created_at', { ascending: false });
  if (error) throw error;
  const items = data.map(r => r.products).filter(p => p?.slug);
  if (!items.length) return stateBox('Your wishlist is empty.', 'Start saving products you love.', '<a class="btn pri" href="#/shop">Browse products</a>');
  return `<h1 style="margin-bottom:16px">Wishlist</h1><div class="grid">${items.map(card).join('')}</div>`;
};

const authForm = (title, fields, btn, extra = '') => `<div class="panel form"><h1 style="margin-bottom:14px">${title}</h1><div id="authMsg"></div><form id="authForm" novalidate>${fields.map(([id, label, type, ac]) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" autocomplete="${ac || 'off'}" required></div>`).join('')}<button class="btn pri" style="width:100%">${btn}</button></form>${extra}</div>`;

routes.login = () => authForm('Sign in', [['email', 'Email', 'email', 'email'], ['password', 'Password', 'password', 'current-password']], 'Sign in',
  '<p style="margin-top:14px"><a href="#/forgot"><u>Forgot password?</u></a></p><p>New here? <a href="#/register"><u>Create an account</u></a></p>');
routes.register = () => authForm('Create account', [['full_name', 'Full name', 'text', 'name'], ['email', 'Email', 'email', 'email'], ['phone', 'Phone number', 'tel', 'tel'], ['password', 'Password (8+ characters, letters and numbers)', 'password', 'new-password'], ['confirm', 'Confirm password', 'password', 'new-password']], 'Create account',
  '<p style="margin-top:14px">Already registered? <a href="#/login"><u>Sign in</u></a></p>');
routes.forgot = () => authForm('Reset your password', [['email', 'Email', 'email', 'email']], 'Send me a code');
routes.verify2fa = () => state.user ? authForm('Two-step verification', [['code', '6-digit code from your authenticator app', 'text', 'one-time-code']], 'Verify',
  '<p style="margin-top:14px"><a href="#/" data-action="logout"><u>Use a different account</u></a></p><p class="brand" style="margin-top:8px">Lost your phone? Contact us and we will help once we have confirmed it is you.</p>') : (go('#/login'), null);
routes.resetcode = () => authForm('Enter your code', [['code', '6-digit code from your email', 'text', 'one-time-code'], ['password', 'New password (8+ characters, letters and numbers)', 'password', 'new-password'], ['confirm', 'Confirm new password', 'password', 'new-password']], 'Reset password',
  '<p style="margin-top:14px">No code yet? Check spam, or <a href="#/forgot"><u>send a new one</u></a>.</p>');
routes.reset = () => authForm('Choose a new password', [['password', 'New password', 'password', 'new-password'], ['confirm', 'Confirm password', 'password', 'new-password']], 'Update password');
routes.contact = () => docPage('Contact us', `<p>We are happy to help with orders, deliveries and returns.</p>${state.settings.store_email ? `<p><b>Email:</b> ${esc(state.settings.store_email)}</p>` : ''}${state.settings.store_phone ? `<p><b>Phone:</b> ${esc(state.settings.store_phone)}</p>` : ''}${state.settings.store_address ? `<p><b>Address:</b> ${esc(state.settings.store_address)}</p>` : ''}${/^\d{8,15}$/.test(String(POLICY.whatsapp || '').replace(/\D/g, '')) ? `<p><a class="btn pri" href="https://wa.me/${String(POLICY.whatsapp).replace(/\D/g, '')}" target="_blank" rel="noopener">Chat on WhatsApp</a></p>` : ''}<p>When you write to us, please include your order number.</p>`);
routes.notfound = () => stateBox('Page not found', '', '<a class="btn" href="#/">Go home</a>');


/* ---------- information pages (wording uses policy.js and your store settings) ---------- */
const bizName = () => esc(POLICY.businessName || state.settings.store_name || 'TechHub');
const contactLine = () => [state.settings.store_email, state.settings.store_phone].filter(Boolean).map(esc).join(' or ') || 'the details on our <a href="#/contact"><u>Contact page</u></a>';
const sections = list => list.map(([h, p]) => `<h2>${h}</h2>${[].concat(p).map(x => `<p>${x}</p>`).join('')}`).join('');
function docPage(title, html, dated = false) {
  document.title = `${title} | ${state.settings.store_name || 'TechHub'}`;
  return `<article class="panel doc"><h1>${esc(title)}</h1>${dated ? `<p class="brand">Last updated: ${esc(POLICY.lastUpdated)}</p>` : ''}${html}</article>`;
}

routes.terms = () => docPage('Terms and conditions', sections([
  ['1. About these terms', `These terms apply to your use of this website and to every purchase from ${bizName()} ("we", "us"). By placing an order you agree to them.`],
  ['2. Your account', 'Give us accurate details and keep your password secret. You are responsible for activity on your account. We may suspend accounts used for fraud, abuse or fake orders.'],
  ['3. Products and prices', `Prices are shown in ${esc(state.settings.currency || 'NGN')} and include the discounts displayed. We work hard to keep prices, descriptions and stock accurate. If we find an error, we will contact you to correct or cancel the order. Product images are illustrative.`],
  ['4. Orders', 'Placing an order is an offer to buy. An order is accepted when we confirm it. We may cancel an order for lack of stock, a pricing error or suspected fraud. If that happens, we will tell you and refund anything you paid.'],
  ['5. Payment', 'You can pay online through Paystack (card, bank transfer or USSD). We never see or store your card details. If pay on delivery is offered, you pay the rider the exact order total when the order arrives. We may limit pay on delivery by order value. An order is marked paid only after the payment is verified or the cash is collected.'],
  ['6. Delivery', 'Delivery times are estimates, not guarantees. Please give a correct address and a phone number that is switched on, and make sure someone can receive the order. See our <a href="#/returns"><u>Delivery and returns</u></a> page for details.'],
  ['7. Returns and refunds', 'Our <a href="#/returns"><u>Delivery and returns</u></a> page explains what can be returned and how refunds work. It forms part of these terms.'],
  ['8. Reviews', 'Only customers who received a product can review it. Reviews must be honest. We may remove reviews that are abusive, unlawful or unrelated to the product.'],
  ['9. Warranty', 'Many electronics carry a manufacturer warranty. Check the product details, or ask us before you buy, so you know what cover applies.'],
  ['10. Our responsibility', 'Nothing in these terms limits any right you have under Nigerian consumer protection law. Apart from that, we are not responsible for indirect losses, such as lost profits, that were not reasonably foreseeable.'],
  ['11. Changes', 'We may update these terms. The date at the top shows the latest version. The version in force when you place an order applies to that order.'],
  ['12. Governing law and contact', `These terms are governed by the laws of the Federal Republic of Nigeria. Questions? Contact us at ${contactLine()}.`],
]), true);

routes.privacy = () => docPage('Privacy policy', sections([
  ['1. Who we are', `${bizName()} runs this online store and is responsible for your personal data. Contact: ${contactLine()}.`],
  ['2. What we collect', 'Your name, email address and phone number; your delivery addresses; your orders, payment status and reviews; and your wishlist. Your password is stored in protected form, and our staff cannot see it. We do not store your card details. Your browser keeps your login and cart so the site works.'],
  ['3. Why we use it', 'To process and deliver your orders, to send order updates and account emails (such as welcome messages and password reset codes), to prevent fraud, to answer your questions, and to meet legal and accounting duties.'],
  ['4. Who we share it with', 'Delivery riders receive your name, phone number, address and order contents so they can deliver. Paystack processes online payments. Google is used to send our emails. Our database and hosting provider stores the data for us. We may share data with authorities when the law requires it. We do not sell your personal data.'],
  ['5. Keeping it safe', 'Access to data is limited by role: customers see only their own data, and staff see only what their job needs. We keep order records for as long as we need them for legal and accounting reasons. Our providers may process data outside Nigeria, with appropriate safeguards.'],
  ['6. Your rights', `Under the Nigeria Data Protection Act 2023 you can ask to see, correct or delete your personal data, and to object to how we use it. We may need to keep some records the law requires. To make a request, contact ${contactLine()}.`],
  ['7. Cookies and browser storage', 'We use browser storage only for things the site needs, such as keeping you signed in and remembering your cart. We do not use advertising or tracking cookies.'],
  ['8. Children', 'This store is not meant for people under 18.'],
  ['9. Changes', 'We may update this policy. The date at the top shows the latest version.'],
]), true);

routes.returns = () => {
  const free = +state.settings.free_shipping_threshold || 0, fee = +state.settings.shipping_flat_fee || 0;
  return docPage('Delivery and returns', sections([
    ['Delivery times', `Lagos: ${esc(POLICY.deliveryLagos)}. Other states: ${esc(POLICY.deliveryElsewhere)}. These are estimates and can be affected by weather, traffic and public holidays.`],
    ['Delivery fee', `${fee ? `The delivery fee is ${money(fee)}. ` : 'Delivery is free. '}${free ? `Orders of ${money(free)} or more are delivered free.` : ''} The exact fee is shown before you place your order.`],
    ['Tracking your order', 'Sign in and open <a href="#/account"><u>My account</u></a> to see your order status. When your order is out for delivery you will see your rider\'s name and phone number.'],
    ['Paying on delivery', 'If you chose pay on delivery, please have the exact amount ready. Check that the package is intact before you pay the rider.'],
    ['If we cannot deliver', 'If nobody can receive the order, the rider will try to reach you. Repeated failed attempts may lead to the order being cancelled.'],
    ['What you can return', `You can ask to return an item within ${esc(POLICY.returnDays)} days of delivery if it is faulty, damaged on arrival, not what you ordered, or not as described. Other returns, such as a change of mind, are accepted at our discretion for unused items in sealed, original packaging.`],
    ['What we cannot accept', 'Items damaged by misuse, items with missing parts or accessories, and items with tampered seals or serial numbers, unless they arrived faulty.'],
    ['How to return an item', `Contact us at ${contactLine()} with your order number and clear photos of the problem. We will tell you how to send the item back or arrange a pick-up.`],
    ['Refunds', `Once we approve a return, we refund you within ${esc(POLICY.refundDays)}. Online payments go back to the original payment method. Pay on delivery refunds are sent by bank transfer.`],
  ]), true);
};

routes.about = () => docPage('About us', `<p>${bizName()} is an online store for smartphones, laptops, gaming gear and smart gadgets. We make it simple to compare products, pay online or on delivery, and follow your order until it reaches your door.</p>
  <p>Questions about a product or an order? Our team is happy to help. See the <a href="#/contact"><u>Contact page</u></a>.</p>`);

routes.faq = () => docPage('Frequently asked questions', [
  ['How do I place an order?', 'Add products to your cart, go to checkout, enter your delivery details and choose how you want to pay.'],
  ['Can I pay on delivery?', 'Yes, where it is offered. Choose "Pay on delivery" at checkout and pay the rider when your order arrives. We may limit this option by order value.'],
  ['How do I track my order?', 'Sign in and open My account. You will see the status of every order, and your rider\'s name and phone number when the order is out for delivery.'],
  ['How long does delivery take?', `Lagos: ${esc(POLICY.deliveryLagos)}. Other states: ${esc(POLICY.deliveryElsewhere)}.`],
  ['Can I cancel my order?', 'Contact us as soon as possible. Orders can only be cancelled before they are shipped.'],
  ['How do I return a faulty item?', `Contact us within ${esc(POLICY.returnDays)} days of delivery with your order number and photos. See <a href="#/returns"><u>Delivery and returns</u></a>.`],
  ['I forgot my password.', 'Click "Forgot password" on the sign-in page. We will email you a 6-digit code to set a new one.'],
].map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join(''));

routes['how-to-shop'] = () => docPage('How to shop', sections([
  ['1. Find what you need', 'Search by product name, brand or SKU, or browse the categories. Use the filters to narrow the list by price, brand and rating.'],
  ['2. Add to cart', 'Open a product to see its photos, specifications and reviews, then click Add to Cart.'],
  ['3. Check out', 'Sign in or create a free account, confirm your delivery address, and choose how to pay: online with Paystack, or on delivery where it is offered.'],
  ['4. Track your order', 'Open <a href="#/account/orders"><u>My account</u></a> to see your delivery date, every step of your order, and your rider\'s name and phone number once your order is out for delivery.'],
  ['5. Receive and confirm', 'When your order is out for delivery you get a 4-digit delivery code by email and in your account. Give it to the rider only when you have received your order.'],
  ['6. Share your review', 'After delivery, rate the product to help other shoppers.'],
]));

routes.bulk = () => {
  const e = state.settings.store_email, wa = String(POLICY.whatsapp || '').replace(/\D/g, '');
  return docPage('Bulk and corporate orders', `<p>Buying for an office, a school or a business? Tell us what you need and we will get back to you with a quote.</p>
    <p>Please include the products and quantities you need, your delivery location, and when you need them.</p>
    ${e ? `<p><a class="btn pri" href="mailto:${esc(e)}?subject=${encodeURIComponent('Bulk order enquiry')}">Email us</a></p>` : ''}
    ${/^\d{8,15}$/.test(wa) ? `<p><a class="btn" href="https://wa.me/${wa}?text=${encodeURIComponent('Hello, I would like a quote for a bulk order.')}" target="_blank" rel="noopener">Chat on WhatsApp</a></p>` : ''}
    ${!e && !/^\d{8,15}$/.test(wa) ? '<p>Please use our <a href="#/contact"><u>Contact page</u></a>.</p>' : ''}`);
};

function renderFooter() {
  const s = state.settings, name = esc(s.store_name || 'TechHub');
  const wa = String(POLICY.whatsapp || '').replace(/\D/g, ''), hasWa = /^\d{8,15}$/.test(wa);
  const label = { instagram: 'Instagram', facebook: 'Facebook', x: 'X', tiktok: 'TikTok', youtube: 'YouTube' };
  const social = Object.entries(POLICY.social || {}).filter(([, u]) => /^https:\/\//.test(u || ''));
  const pays = ['Visa', 'Mastercard', 'Verve', 'Bank transfer', 'USSD', ...(s.cod_enabled !== false ? ['Pay on delivery'] : [])];
  const row = (k, v) => v ? `<p class="fc"><span>${k}</span>${esc(v)}</p>` : '';
  $('#footer').innerHTML = `<div class="foot-grid">
      <div><h3>Need help?</h3>${hasWa ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener">Chat with us on WhatsApp</a>` : ''}<a href="#/faq">Help centre (FAQ)</a><a href="#/contact">Contact us</a><a href="#/account/orders">Track my order</a><a href="#/contact">Report a problem with an order</a></div>
      <div><h3>Useful links</h3><a href="#/how-to-shop">How to shop</a><a href="#/returns">Delivery, returns &amp; refunds</a><a href="#/bulk">Bulk and corporate orders</a><a href="#/shop?f=deals">Deals</a><a href="#/shop?f=new">New arrivals</a><a href="#/shop?f=best">Best sellers</a></div>
      <div><h3>About ${name}</h3><a href="#/about">About us</a><a href="#/terms">Terms &amp; conditions</a><a href="#/privacy">Privacy policy</a></div>
      <div><h3>Shop by category</h3>${state.cats.slice(0, 7).map(c => `<a href="#/shop?cat=${c.id}">${esc(c.name)}</a>`).join('')}</div></div>
    <div class="foot-grid foot-row2">
      <div><h3>Contact us</h3>${row('Business', POLICY.businessName || s.store_name)}${row('Address', s.store_address)}${row('Phone', s.store_phone)}${row('Email', s.store_email)}${hasWa ? row('WhatsApp', wa) : ''}${row('Hours', POLICY.hours)}</div>
      <div><h3>Join us on</h3>${social.length ? social.map(([k, u]) => `<a class="fpill" href="${esc(u)}" target="_blank" rel="noopener">${label[k] || esc(k)}</a>`).join('') : '<p class="fc">Follow us soon.</p>'}</div>
      <div><h3>Payment methods</h3>${pays.map(x => `<span class="fpill">${x}</span>`).join('')}</div>
      <div class="fbrands"><h3>Top brands</h3>${state.brands.slice(0, 8).map(b => `<a href="#/shop?brand=${b.id}">${esc(b.name)}</a>`).join('') || '<p class="fc">Coming soon.</p>'}</div></div>
    <div class="foot-base"><span>&copy; ${new Date().getFullYear()} ${name}. All rights reserved.</span><a href="#" id="toTop">Back to top &uarr;</a></div>`;
  $('#toTop').addEventListener('click', e => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
}

/* ---------- my account: orders, tracking and profile ---------- */
const STATUS_INFO = {
  pending:    { label: 'Order placed',     badge: 'b-wait' },
  confirmed:  { label: 'Confirmed',        badge: 'b-info' },
  processing: { label: 'Being prepared',   badge: 'b-info' },
  shipped:    { label: 'Out for delivery', badge: 'b-ship' },
  delivered:  { label: 'Delivered',        badge: 'b-ok' },
  cancelled:  { label: 'Cancelled',        badge: 'b-bad' },
};
const TRACK = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];
const TRACK_TEXT = {
  pending: ['Order placed', 'We have received your order.'],
  confirmed: ['Order confirmed', 'The store has accepted your order.'],
  processing: ['Being prepared', 'Your items are being checked and packed.'],
  shipped: ['Out for delivery', 'A rider is bringing your order to you.'],
  delivered: ['Delivered', 'Your order has arrived. Enjoy!'],
};
const ORDER_SELECT = '*, order_items(product_id,product_name,quantity,unit_price,products(slug,product_images(url,sort_order))), delivery_codes(code)';
const fmtDay = d => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtStamp = d => `${fmtDay(d)}, ${new Date(d).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
const itemImg = i => [...(i.products?.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)[0]?.url || PLACEHOLDER;

function addBusinessDays(from, n) { // Monday to Friday
  const d = new Date(from); let left = n;
  while (left > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) left--; }
  return d;
}
/* Delivery estimate from the order date, using policy.js (Lagos vs other states). */
function etaFor(o) {
  const days = (POLICY.deliveryDays || { lagos: [1, 3], other: [3, 7] })[/lagos/i.test(o.ship_state) ? 'lagos' : 'other'];
  const from = addBusinessDays(o.created_at, days[0]), to = addBusinessDays(o.created_at, days[1]);
  return { from, to, hours: POLICY.deliveryHours || '9am to 6pm', range: fmtDay(from) === fmtDay(to) ? fmtDay(from) : `${fmtDay(from)} to ${fmtDay(to)}` };
}
function deliveryLine(o) {
  if (o.status === 'cancelled') return { cls: 'bad', text: 'This order was cancelled.' };
  if (o.status === 'delivered') return { cls: 'ok', text: `Delivered${o.delivered_at ? ' on ' + fmtStamp(o.delivered_at) : ''}` };
  if (o.payment_method === 'paystack' && o.payment_status !== 'paid') return { cls: 'wait', text: 'Complete your payment to schedule delivery.' };
  if (o.status === 'shipped') return { cls: 'ship', text: 'Your order is out for delivery. Keep your phone nearby.' };
  const e = etaFor(o);
  if (new Date() > new Date(e.to.getTime() + 864e5)) return { cls: 'wait', text: 'Your delivery is taking longer than expected. We are working on it.' };
  return { cls: 'wait', text: `Estimated delivery: <b>${e.range}</b>, ${esc(e.hours)}` };
}

function orderCard(o) {
  const st = STATUS_INFO[o.status], dl = deliveryLine(o), count = o.order_items.reduce((n, i) => n + i.quantity, 0);
  const pay = o.payment_status === 'unpaid' && o.status === 'pending' && o.payment_method === 'paystack' ? `<button class="btn pri sm" data-action="pay" data-id="${o.id}">Pay now</button>` : '';
  return `<article class="ocard">
    <div class="oc-head"><div><b>Order ${esc(o.order_number)}</b><div class="brand">Placed ${fmtDay(o.created_at)} ${new Date(o.created_at).getFullYear()} · ${count} item${count > 1 ? 's' : ''}</div></div><span class="bdg ${st.badge}">${st.label}</span></div>
    <div class="oc-items">${o.order_items.slice(0, 4).map(i => `<img src="${esc(itemImg(i))}" alt="${esc(i.product_name)}" loading="lazy">`).join('')}${o.order_items.length > 4 ? `<span class="more">+${o.order_items.length - 4}</span>` : ''}
      <div class="oc-names">${o.order_items.slice(0, 2).map(i => `${i.quantity} × ${esc(i.product_name)}`).join('<br>')}${o.order_items.length > 2 ? '<br>…' : ''}</div></div>
    <div class="eta ${dl.cls}">${dl.text}</div>
    <div class="oc-foot"><b>${money(o.total)}</b><span class="oc-actions">${pay}<a class="btn sm" href="#/order/${o.id}">Track order</a></span></div></article>`;
}

/* ---------- account area: sidebar layout (overview, orders, inbox, reviews, addresses, profile) ---------- */
const ICONS = {
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05"/><path d="M12 22.08V12"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="m22 6-10 7L2 6"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
};
const ic = n => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

function accountShell(tab, title, inner, unread = 0) {
  const link = (k, href, icon, label, badge = '') => `<a class="${tab === k ? 'on' : ''}" href="${href}">${ic(icon)}<span>${label}</span>${badge}</a>`;
  return `<div class="acct"><nav class="acct-nav" aria-label="Account">
    ${link('overview', '#/account', 'user', 'My account')}${link('orders', '#/account/orders', 'box', 'Orders')}${link('inbox', '#/account/inbox', 'mail', 'Inbox', unread ? `<em class="nbadge">${unread}</em>` : '')}${link('reviews', '#/account/reviews', 'star', 'Pending reviews')}${link('wishlist', '#/wishlist', 'heart', 'Wishlist')}${link('viewed', '#/account/viewed', 'clock', 'Recently viewed')}<hr>
    ${link('addresses', '#/account/addresses', 'pin', 'Address book')}${link('profile', '#/account/profile', 'lock', 'Profile &amp; security')}${link('2fa', '#/account/2fa', 'shield', 'Two-step verification')}<hr>
    <a href="#/" data-action="logout">${ic('out')}<span>Logout</span></a></nav>
    <section class="acct-main panel"><h1 class="acct-title">${title}</h1>${inner}</section></div>`;
}

async function unreadCount() {
  const { count } = await db.from('notifications').select('id', { count: 'exact', head: true }).eq('is_read', false);
  return count || 0;
}

/* Delivered products the customer has not reviewed yet. */
async function pendingReviews() {
  const [{ data: orders }, { data: mine }] = await Promise.all([
    db.from('orders').select('delivered_at,created_at,order_items(product_id,product_name,products(slug,product_images(url,sort_order)))').eq('status', 'delivered').order('created_at', { ascending: false }).limit(50),
    db.from('reviews').select('product_id').eq('user_id', state.user.id),
  ]);
  const done = new Set((mine || []).map(r => r.product_id)), seen = new Set(), out = [];
  (orders || []).forEach(o => o.order_items.forEach(i => {
    if (i.product_id && i.products?.slug && !done.has(i.product_id) && !seen.has(i.product_id)) { seen.add(i.product_id); out.push({ ...i, when: o.delivered_at || o.created_at }); }
  }));
  return out;
}

async function accOverview() {
  const pr = state.profile || {};
  const [{ data: addr }, { data: last }, pend, { data: mf }] = await Promise.all([
    db.from('addresses').select('*').order('is_default', { ascending: false }).limit(1),
    db.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false }).limit(1),
    pendingReviews(),
    db.auth.mfa.listFactors(),
  ]);
  const a = addr?.[0], o = last?.[0], twoOn = (mf?.totp || []).length > 0;
  return ['Account overview', `<div class="cards2">
    <div class="cardbox"><h3>Account details</h3><div class="cb"><b>${esc(pr.full_name || '')}</b><br><span class="brand">${esc(state.user.email)}</span>${pr.phone ? `<br><span class="brand">${esc(pr.phone)}</span>` : ''}<p><a href="#/account/profile"><u>Edit details</u></a></p></div></div>
    <div class="cardbox"><h3>Address book</h3><div class="cb">${a ? `Your default shipping address:<br><b>${esc(a.recipient)}</b><br>${esc(a.address_line)}, ${esc(a.city)}, ${esc(a.state)}` : '<span class="brand">No saved address yet.</span>'}<p><a href="#/account/addresses"><u>${a ? 'Manage addresses' : 'Add an address'}</u></a></p></div></div>
    <div class="cardbox"><h3>Latest order</h3><div class="cb">${o ? `<b>${esc(o.order_number)}</b> <span class="bdg ${STATUS_INFO[o.status].badge}">${STATUS_INFO[o.status].label}</span><p class="brand" style="margin:6px 0">${deliveryLine(o).text}</p><a href="#/order/${o.id}"><u>Track order</u></a> · <a href="#/account/orders"><u>All orders</u></a>` : '<span class="brand">You have not placed an order yet.</span><p><a href="#/shop"><u>Start shopping</u></a></p>'}</div></div>
    <div class="cardbox"><h3>Account security</h3><div class="cb">Two-step verification: <span class="bdg ${twoOn ? 'b-ok' : 'b-wait'}">${twoOn ? 'On' : 'Off'}</span><p class="brand" style="margin:6px 0">${twoOn ? 'Your account asks for a code at every sign-in.' : 'Add a second lock so a stolen password is not enough.'}</p><a href="#/account/2fa"><u>${twoOn ? 'Manage' : 'Turn on'}</u></a></div></div>
    <div class="cardbox"><h3>Pending reviews</h3><div class="cb">${pend.length ? `<b>${pend.length}</b> item${pend.length > 1 ? 's' : ''} waiting for your review.<p><a href="#/account/reviews"><u>Review now</u></a></p>` : '<span class="brand">You are all caught up.</span>'}</div></div></div>`];
}

async function accOrders(p) {
  const { data: orders, error } = await db.from('orders').select(ORDER_SELECT).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  const f = p.f || 'all';
  const match = { open: o => !['delivered', 'cancelled'].includes(o.status), delivered: o => o.status === 'delivered', cancelled: o => o.status === 'cancelled' }[f] || (() => true);
  const list = orders.filter(match);
  const chip = (k, l) => `<a class="chip ${f === k ? 'on' : ''}" href="#/account/orders${k === 'all' ? '' : '?f=' + k}">${l}</a>`;
  return ['Orders', `<div class="chips">${chip('all', 'All')}${chip('open', 'In progress')}${chip('delivered', 'Delivered')}${chip('cancelled', 'Cancelled')}</div>` +
    (list.length ? list.map(orderCard).join('') : stateBox(orders.length ? 'No orders here' : 'No orders yet', orders.length ? 'Try another filter.' : 'Your orders will appear here.', '<a class="btn pri" href="#/shop">Start shopping</a>'))];
}

async function accInbox() {
  const { data, error } = await db.from('notifications').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  if ((data || []).some(n => !n.is_read)) db.from('notifications').update({ is_read: true }).eq('user_id', state.user.id).eq('is_read', false).then(() => {});
  return ['Inbox', data.length ? data.map(n => `<div class="msgrow ${n.is_read ? '' : 'unread'}"><div><b>${esc(n.title)}</b><p>${esc(n.body || '')}</p></div><small>${fmtStamp(n.created_at)}</small></div>`).join('') : stateBox('Your inbox is empty', 'Order updates appear here.')];
}

async function accReviews() {
  const list = await pendingReviews();
  return ['Pending reviews', list.length ? list.map(i => `<div class="irow"><img src="${esc(itemImg(i))}" alt="" loading="lazy"><div><b>${esc(i.product_name)}</b><div class="brand">Delivered ${fmtDay(i.when)}</div></div><a class="btn pri sm" href="#/product/${esc(i.products.slug)}">Write a review</a></div>`).join('') : stateBox('You are all caught up', 'Delivered items you have not reviewed will appear here.')];
}

async function accViewed() {
  let ids = []; try { ids = JSON.parse(localStorage.getItem('viewed')) || []; } catch { /* storage unavailable */ }
  if (!ids.length) return ['Recently viewed', stateBox('Nothing viewed yet', 'Products you look at appear here.', '<a class="btn pri" href="#/shop">Browse products</a>')];
  const { data, error } = await db.from('products').select(PRODUCT_SELECT).in('id', ids).eq('is_active', true);
  if (error) throw error;
  const rank = new Map(ids.map((id, n) => [id, n])); data.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  return ['Recently viewed', `<div class="grid">${data.map(card).join('')}</div>`];
}

async function accAddresses(p) {
  const { data, error } = await db.from('addresses').select('*').order('is_default', { ascending: false }).order('created_at', { ascending: false });
  if (error) throw error;
  const editing = p.edit ? data.find(a => a.id === p.edit) : null, showForm = !!(p.new || editing);
  const f = (id, label, v = '', type = 'text') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" value="${esc(v)}" required></div>`;
  const form = `<form class="cardbox" id="addrForm" data-id="${editing?.id || ''}" style="padding:16px;margin-bottom:16px" novalidate><h2>${editing ? 'Edit address' : 'Add a new address'}</h2><div id="adMsg"></div>
    <div class="row2">${f('recipient', 'Full name', editing?.recipient ?? state.profile?.full_name)}${f('phone', 'Phone number', editing?.phone ?? state.profile?.phone, 'tel')}</div>
    ${f('address_line', 'Street address, house number and landmark', editing?.address_line)}
    <div class="row2">${f('city', 'City', editing?.city)}${f('state', 'State', editing?.state)}</div>
    <div class="row2">${f('country', 'Country', editing?.country ?? 'Nigeria')}${f('label', 'Label (Home, Work…)', editing?.label ?? 'Home')}</div>
    <label class="check" style="margin-bottom:12px"><input type="checkbox" name="is_default" ${editing?.is_default || !data.length ? 'checked' : ''}> Make this my default address</label>
    <div class="oc-actions"><button class="btn pri">Save address</button><a class="btn ghost" href="#/account/addresses">Cancel</a></div></form>`;
  const list = data.map(a => `<div class="cardbox" style="margin-bottom:12px"><div class="cb"><b>${esc(a.label)}</b> ${a.is_default ? '<span class="bdg b-ok">Default</span>' : ''}
    <p style="margin:6px 0">${esc(a.recipient)}<br>${esc(a.address_line)}<br>${esc(a.city)}, ${esc(a.state)}, ${esc(a.country)}<br>${esc(a.phone)}</p>
    <div class="oc-actions" style="flex-wrap:wrap"><a class="btn sm" href="#/account/addresses?edit=${a.id}">Edit</a>${a.is_default ? '' : `<button class="btn sm ghost" data-action="addr-default" data-id="${a.id}">Make default</button>`}<button class="btn sm ghost" data-action="addr-delete" data-id="${a.id}">Delete</button></div></div></div>`).join('');
  return ['Address book', (showForm ? form : '<p style="margin-bottom:14px"><a class="btn pri" href="#/account/addresses?new=1">Add a new address</a></p>') + (list || (showForm ? '' : stateBox('No saved addresses', 'Save an address to check out faster.')))];
}

async function acc2fa() {
  const { data: f } = await db.auth.mfa.listFactors(), on = (f?.totp || []).length > 0;
  return ['Two-step verification', `<div style="max-width:520px">
    <p>Add a second lock to your account. Even if someone learns your password, they cannot sign in without a 6-digit code from an app on your phone.</p>
    <p style="margin:12px 0"><span class="bdg ${on ? 'b-ok' : 'b-wait'}">${on ? 'On' : 'Off'}</span></p>
    ${on ? '<p class="brand" style="margin-bottom:10px">You will be asked for a code each time you sign in.</p><button class="btn ghost sm" data-action="mfa-off">Turn off</button>' : '<button class="btn pri" data-action="mfa-start">Set up two-step verification</button>'}
    <div id="mfaBox"></div>
    <p class="brand" style="margin-top:18px">Use an authenticator app such as Google Authenticator, Microsoft Authenticator or Authy. Keep your phone safe. If you lose it, contact us and we will help once we have confirmed it is you.</p></div>`];
}

async function accProfile() {
  const pr = state.profile || {}, mail = state.settings.store_email;
  const del = mail ? `mailto:${esc(mail)}?subject=${encodeURIComponent('Account deletion request')}&body=${encodeURIComponent('Please delete my account.\nAccount email: ' + state.user.email)}` : '#/contact';
  return ['Profile &amp; security', `<div style="max-width:520px">
    <h2>Your details</h2><div id="profMsg"></div>
    <form id="profileForm"><div class="field"><label for="pn">Full name</label><input id="pn" name="full_name" value="${esc(pr.full_name)}" required></div>
      <div class="field"><label for="pp">Phone</label><input id="pp" name="phone" value="${esc(pr.phone)}"></div>
      <div class="field"><label for="pe">Email</label><input id="pe" value="${esc(state.user.email)}" disabled></div><button class="btn pri sm">Save changes</button></form>

    <h2 style="margin-top:28px">Change password</h2><div id="pwMsg"></div>
    <form id="pwForm" novalidate>
      <div class="field"><label for="pw0">Current password</label><input id="pw0" name="current" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="pw1">New password (8+ characters, letters and numbers)</label><input id="pw1" name="new_password" type="password" autocomplete="new-password" required></div>
      <div class="field"><label for="pw2">Confirm new password</label><input id="pw2" name="confirm" type="password" autocomplete="new-password" required></div>
      <button class="btn pri sm">Change password</button> <button type="button" class="btn ghost sm" data-action="resetpw">I forgot my current password</button></form>

    <h2 style="margin-top:28px">Devices</h2><p class="brand" style="margin-bottom:10px">Lost a phone, or used a shared computer? Sign out everywhere.</p>
    <button class="btn ghost sm" data-action="logout-all">Sign out of all devices</button>

    <div class="dz" style="margin-top:28px"><h2 style="color:var(--err)">Delete account</h2>
      <p style="margin:6px 0 10px">Ask us to delete your account and personal details. We keep order records for as long as the law requires. The request opens an email to us from your own address, which confirms it is really you.</p>
      <a class="btn sm" style="background:var(--err);border-color:var(--err)" href="${del}">Request account deletion</a></div></div>`];
}

routes.account = async (arg, p) => {
  if (!state.user) { sessionStorage.setItem('after', '#/account'); return go('#/login'), null; }
  const tab = arg || 'overview';
  const views = { overview: accOverview, orders: accOrders, inbox: accInbox, reviews: accReviews, viewed: accViewed, addresses: accAddresses, profile: accProfile, '2fa': acc2fa };
  if (!views[tab]) return routes.notfound();
  const unread = await unreadCount();
  const [title, html] = await views[tab](p);
  return accountShell(tab, title, html, tab === 'inbox' ? 0 : unread);
};

async function changePassword(e) {
  e.preventDefault(); const v = Object.fromEntries(new FormData(e.target));
  if (!validPw(v.new_password)) return showMsg('#pwMsg', 'New password needs 8+ characters with letters and numbers.');
  if (v.new_password !== v.confirm) return showMsg('#pwMsg', 'The new passwords do not match.');
  if (v.new_password === v.current) return showMsg('#pwMsg', 'Choose a different password from your current one.');
  const check = await db.auth.signInWithPassword({ email: state.user.email, password: v.current }); // proves it is really you
  if (check.error) return showMsg('#pwMsg', 'Your current password is not correct.');
  const { error } = await db.auth.updateUser({ password: v.new_password });
  if (error) return showMsg('#pwMsg', error.message);
  toast('Password changed');
}

async function saveAddress(e) {
  e.preventDefault();
  const f = e.target, v = Object.fromEntries(new FormData(f)), id = f.dataset.id;
  if (['recipient', 'phone', 'address_line', 'city', 'state', 'country', 'label'].some(k => !String(v[k] || '').trim())) return showMsg('#adMsg', 'Please complete every field.');
  if (!/^\+?[0-9 -]{7,20}$/.test(v.phone.trim())) return showMsg('#adMsg', 'Enter a valid phone number.');
  const row = { user_id: state.user.id, label: v.label.trim(), recipient: v.recipient.trim(), phone: v.phone.trim(), address_line: v.address_line.trim(), city: v.city.trim(), state: v.state.trim(), country: v.country.trim(), is_default: !!v.is_default };
  if (row.is_default) await db.from('addresses').update({ is_default: false }).eq('user_id', state.user.id);
  const { error } = id ? await db.from('addresses').update(row).eq('id', id) : await db.from('addresses').insert(row);
  if (error) return showMsg('#adMsg', 'Could not save the address: ' + error.message);
  toast('Address saved'); go('#/account/addresses');
}

/* Saves the delivery address used at checkout, if the customer ticked the box. Never blocks an order. */
async function saveCheckoutAddress(fd) {
  try {
    const { data: same } = await db.from('addresses').select('id').eq('user_id', state.user.id).eq('address_line', fd.address.trim()).eq('city', fd.city.trim());
    if (same?.length) return;
    const { count } = await db.from('addresses').select('id', { count: 'exact', head: true }).eq('user_id', state.user.id);
    await db.from('addresses').insert({ user_id: state.user.id, label: 'Home', recipient: fd.name.trim(), phone: fd.phone.trim(), address_line: fd.address.trim(), city: fd.city.trim(), state: fd.state.trim(), country: fd.country.trim(), is_default: !count });
  } catch { /* ignore */ }
}

routes.order = async (id) => {
  if (!state.user) { sessionStorage.setItem('after', location.hash); return go('#/login'), null; }
  const { data: o, error } = await db.from('orders').select(ORDER_SELECT + ', order_status_history(status,created_at)').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!o) return stateBox('Order not found', 'It may belong to another account.', '<a class="btn" href="#/account/orders">My orders</a>');
  document.title = `Order ${o.order_number} | ${state.settings.store_name || 'TechHub'}`;

  const reached = {};
  [...(o.order_status_history || [])].sort((a, b) => a.created_at.localeCompare(b.created_at)).forEach(h => { if (!reached[h.status]) reached[h.status] = h.created_at; });
  const cancelled = o.status === 'cancelled', idx = TRACK.indexOf(o.status), e = etaFor(o), dl = deliveryLine(o);
  const steps = TRACK.map((s, n) => {
    const done = cancelled ? !!reached[s] : n <= idx, now = !cancelled && n === idx;
    const showEta = s === 'delivered' && !cancelled && (o.payment_method === 'cod' || o.payment_status === 'paid');
    const when = reached[s] ? fmtStamp(reached[s]) : (showEta ? `Expected ${e.range}, ${esc(e.hours)}` : '');
    return `<li class="${done ? 'done' : ''} ${now ? 'now' : ''}"><span class="dot"></span><div><b>${TRACK_TEXT[s][0]}</b>${when ? `<small>${when}</small>` : ''}<p>${TRACK_TEXT[s][1]}</p></div></li>`;
  }).join('') + (cancelled ? `<li class="done bad"><span class="dot"></span><div><b>Cancelled</b><small>${reached.cancelled ? fmtStamp(reached.cancelled) : ''}</small><p>This order was cancelled.</p></div></li>` : '');

  const code = one(o.delivery_codes)?.code;
  const rebuy = o.order_items.filter(i => i.product_id).map(i => `${i.product_id}:${i.quantity}`).join(',');
  const row = (l, v) => `<div><span>${l}</span><span>${v}</span></div>`;
  return `<p><a href="#/account/orders"><u>&larr; All orders</u></a></p>
    <div class="od"><section>
      <div class="odbanner eta ${dl.cls}"><b>Order ${esc(o.order_number)}</b> · <span class="bdg ${STATUS_INFO[o.status].badge}">${STATUS_INFO[o.status].label}</span><div style="margin-top:6px">${dl.text}</div></div>
      ${o.status === 'shipped' && (o.rider_name || code) ? `<div class="panel"><h2>Your delivery</h2>
        ${o.rider_name ? `<p>Your rider: <b>${esc(o.rider_name)}</b>${o.rider_phone ? ` · <a href="tel:${esc(o.rider_phone)}"><u>${esc(o.rider_phone)}</u></a>` : ''}</p>` : ''}
        ${code ? `<div class="msg ok"><b>Delivery code: <span style="font-size:1.5rem;letter-spacing:5px">${esc(code)}</span></b><br>Give this code to the rider <u>only when you have received your order</u>.</div>` : ''}</div>` : ''}
      <div class="panel"><h2>Tracking</h2><ol class="vt">${steps}</ol></div>
      <div class="panel"><h2>Items</h2>${o.order_items.map(i => `<div class="irow"><img src="${esc(itemImg(i))}" alt="" loading="lazy"><div>${i.products?.slug ? `<a href="#/product/${esc(i.products.slug)}"><b>${esc(i.product_name)}</b></a>` : `<b>${esc(i.product_name)}</b>`}<div class="brand">Qty ${i.quantity}${o.status === 'delivered' && i.products?.slug ? ` · <a href="#/product/${esc(i.products.slug)}"><u>Rate this item</u></a>` : ''}</div></div><b>${money(i.unit_price * i.quantity)}</b></div>`).join('')}</div>
    </section><aside>
      <div class="panel sum"><h2>Order summary</h2>${row('Subtotal', money(o.subtotal))}${+o.discount_total ? row('Discount', '-' + money(o.discount_total)) : ''}${row('Delivery', +o.shipping_fee ? money(o.shipping_fee) : 'Free')}${+o.tax_total ? row('Tax', money(o.tax_total)) : ''}<div class="tot"><span>Total</span><span>${money(o.total)}</span></div></div>
      <div class="panel"><h2>Payment</h2><p>${o.payment_method === 'cod' ? 'Pay on delivery' : 'Online payment (Paystack)'}</p><p><span class="bdg ${o.payment_status === 'paid' ? 'b-ok' : 'b-wait'}">${o.payment_status === 'paid' ? 'Paid' : o.payment_method === 'cod' ? 'Pay when it arrives' : 'Not paid yet'}</span></p></div>
      <div class="panel"><h2>Delivery address</h2><p><b>${esc(o.ship_name)}</b><br>${esc(o.ship_address)}<br>${esc(o.ship_city)}, ${esc(o.ship_state)}<br>${esc(o.ship_phone)}</p>${o.delivery_notes ? `<p class="brand">Note: ${esc(o.delivery_notes)}</p>` : ''}</div>
      <div class="panel oc-actions" style="flex-wrap:wrap">${o.payment_status === 'unpaid' && o.status === 'pending' && o.payment_method === 'paystack' ? `<button class="btn pri" data-action="pay" data-id="${o.id}">Pay now</button>` : ''}${rebuy ? `<button class="btn" data-action="rebuy" data-items="${esc(rebuy)}">Buy again</button>` : ''}<a class="btn ghost" href="#/contact">Need help?</a></div>
    </aside></div>`;
};

/* ---------- page bindings (forms, filters) ---------- */
const showMsg = (sel, text, ok) => { $(sel).innerHTML = `<div class="msg ${ok ? 'ok' : 'err'}">${esc(text)}</div>`; };
/* Password reset by emailed code (reset-password Edge Function). */
async function callResetFn(body) {
  const { data, error } = await db.functions.invoke('reset-password', { body });
  if (error) { let msg = 'Something went wrong. Please try again.'; try { msg = (await error.context.json()).error || msg; } catch { /* keep default */ } throw new Error(msg); }
  return data;
}
const validPw = p => p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function bindPage(name) {
  if (name === 'shop') {
    const form = $('#filters');
    const apply = (extra = {}) => {
      const fd = new FormData(form), qs = new URLSearchParams();
      fd.forEach((v, k) => { if (v) qs.set(k, v); });
      qs.set('sort', $('#sort').value); Object.entries(extra).forEach(([k, v]) => qs.set(k, v));
      go('#/shop?' + qs);
    };
    form.addEventListener('submit', e => { e.preventDefault(); apply({ page: 1 }); });
    $('#sort').addEventListener('change', () => apply({ page: 1 }));
    $('#fq').addEventListener('input', debounce(() => apply({ page: 1 })));
    app.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => apply({ page: b.dataset.page })));
  }
  if (name === 'product') {
    let q = 1;
    app.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => { q = Math.min(99, Math.max(1, q + +b.dataset.q)); $('#pq').textContent = q; }));
    const rate = $('#rate');
    if (rate) {
      rate.addEventListener('click', e => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        $('#reviewForm').elements.rating.value = b.dataset.v;
        rate.querySelectorAll('button').forEach(x => x.classList.toggle('on', +x.dataset.v <= +b.dataset.v));
      });
      $('#reviewForm').addEventListener('submit', submitReview);
    }
    app.querySelectorAll('[data-thumb]').forEach(b => b.addEventListener('click', () => {
      $('#mainImg').src = b.dataset.thumb; app.querySelectorAll('[data-thumb]').forEach(x => x.classList.toggle('on', x === b));
    }));
  }
  const form = $('#authForm');
  if (form) form.addEventListener('submit', e => { e.preventDefault(); authSubmit(name, Object.fromEntries(new FormData(form))); });
  if (name === 'checkout') {
    $('#checkoutForm').addEventListener('submit', placeOrder);
    const pick = $('#addrPick');
    if (pick) pick.addEventListener('change', () => {
      const a = checkoutAddrs.find(x => x.id === pick.value), set = (id, v) => { $('#' + id).value = v ?? ''; };
      set('name', a ? a.recipient : state.profile?.full_name); set('phone', a ? a.phone : state.profile?.phone);
      set('address', a?.address_line); set('city', a?.city); set('state', a?.state); set('country', a ? a.country : 'Nigeria');
    });
  }
  if (name === 'account' && $('#profileForm')) $('#profileForm').addEventListener('submit', saveProfile);
  if (name === 'account' && $('#pwForm')) $('#pwForm').addEventListener('submit', changePassword);
  if (name === 'account' && $('#addrForm')) $('#addrForm').addEventListener('submit', saveAddress);
}

async function authSubmit(name, v) {
  const btn = $('#authForm button'); btn.disabled = true;
  try {
    if (name === 'login') {
      const { data: si, error } = await db.auth.signInWithPassword({ email: v.email.trim(), password: v.password });
      if (error) throw error;
      await onSession(si.user);
      const after = sessionStorage.getItem('after') || '#/account';
      if (state.needs2fa) { sessionStorage.setItem('after', after); go('#/verify2fa'); } else { sessionStorage.removeItem('after'); go(after); }
    } else if (name === 'verify2fa') {
      if (!/^\d{6}$/.test(v.code.trim())) throw new Error('Enter the 6-digit code from your authenticator app.');
      const { data: f } = await db.auth.mfa.listFactors(); const factor = f?.totp?.[0];
      if (!factor) throw new Error('No authenticator is set up for this account.');
      const ch = await db.auth.mfa.challenge({ factorId: factor.id }); if (ch.error) throw ch.error;
      const vr = await db.auth.mfa.verify({ factorId: factor.id, challengeId: ch.data.id, code: v.code.trim() });
      if (vr.error) throw new Error('That code is not correct. Try again.');
      await onSession(state.user);
      const after = sessionStorage.getItem('after') || '#/account'; sessionStorage.removeItem('after'); go(after); return;
    } else if (name === 'register') {
      if (v.full_name.trim().length < 2) throw new Error('Enter your full name.');
      if (!validEmail(v.email)) throw new Error('Enter a valid email address.');
      if (!/^\+?[\d\s-]{7,15}$/.test(v.phone)) throw new Error('Enter a valid phone number.');
      if (!validPw(v.password)) throw new Error('Password needs 8+ characters with letters and numbers.');
      if (v.password !== v.confirm) throw new Error('Passwords do not match.');
      const { data, error } = await db.auth.signUp({ email: v.email.trim(), password: v.password, options: { data: { full_name: v.full_name.trim(), phone: v.phone.trim() }, emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (data.session) { toast('Account created. Welcome!'); go(sessionStorage.getItem('after') || '#/account'); sessionStorage.removeItem('after'); return; } // email confirmation is off: already signed in
      app.innerHTML = stateBox('Check your email', 'We sent a verification link. Confirm your email, then sign in.', '<a class="btn pri" href="#/login">Go to sign in</a>');
      return;
    } else if (name === 'forgot') {
      if (!validEmail(v.email)) throw new Error('Enter a valid email address.');
      await callResetFn({ action: 'request', email: v.email.trim() });
      sessionStorage.setItem('resetEmail', v.email.trim()); go('#/resetcode'); return;
    } else if (name === 'resetcode') {
      const email = sessionStorage.getItem('resetEmail'); if (!email) return go('#/forgot');
      if (!/^\d{6}$/.test(v.code.trim())) throw new Error('Enter the 6-digit code from your email.');
      if (!validPw(v.password)) throw new Error('Password needs 8+ characters with letters and numbers.');
      if (v.password !== v.confirm) throw new Error('Passwords do not match.');
      await callResetFn({ action: 'confirm', email, code: v.code.trim(), password: v.password });
      sessionStorage.removeItem('resetEmail');
      const { data: si, error } = await db.auth.signInWithPassword({ email, password: v.password });
      if (error) { toast('Password updated. Please sign in.'); return go('#/login'); }
      await onSession(si.user);
      toast('Password updated. Welcome back!'); go(state.needs2fa ? '#/verify2fa' : '#/account'); return;
    } else if (name === 'reset') {
      if (!validPw(v.password)) throw new Error('Password needs 8+ characters with letters and numbers.');
      if (v.password !== v.confirm) throw new Error('Passwords do not match.');
      const { error } = await db.auth.updateUser({ password: v.password });
      if (error) throw error;
      toast('Password updated'); go('#/account');
    }
  } catch (e) { showMsg('#authMsg', e.message); } finally { btn.disabled = false; }
}

async function saveProfile(e) {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  const { error } = await db.from('profiles').update({ full_name: fd.full_name.trim(), phone: fd.phone.trim() }).eq('id', state.user.id);
  if (error) return showMsg('#profMsg', error.message);
  state.profile = { ...state.profile, ...fd }; showMsg('#profMsg', 'Profile saved.', true);
}

async function placeOrder(e) {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target)), btn = $('#placeBtn');
  if (['name', 'phone', 'email', 'address', 'city', 'state', 'country'].some(k => !String(fd[k]).trim())) return showMsg('#ckMsg', 'Complete all delivery fields.');
  if (!validEmail(fd.email)) return showMsg('#ckMsg', 'Enter a valid email address.');
  btn.disabled = true; btn.textContent = 'Placing order…';
  // Only ids and quantities are sent. The database computes every price and total.
  const { data, error } = await db.rpc('place_order', { p_items: state.cart.map(i => ({ product_id: i.id, quantity: i.qty })), p_shipping: fd, p_notes: fd.notes || null, p_payment_method: fd.payment === 'cod' ? 'cod' : 'paystack' });
  if (error) { btn.disabled = false; btn.textContent = 'Place order'; return showMsg('#ckMsg', error.message); }
  if (fd.save_addr) await saveCheckoutAddress(fd);
  state.cart = []; saveCart();
  if (fd.payment === 'cod') return go('#/confirmed/' + data); // pay the rider on delivery
  await startPayment(data);
}

/* Asks the init-payment Edge Function for a Paystack link. The amount is read from the order server-side. */
async function startPayment(orderId) {
  const { data, error } = await db.functions.invoke('init-payment', { body: { order_id: orderId } });
  if (error || !data?.authorization_url) {
    toast('Your order is saved, but payment could not start. You can pay from your account.', true);
    return go('#/account');
  }
  location.assign(data.authorization_url);
}

/* ---------- global actions (event delegation) ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const { action, id } = el.dataset;
  const qty = el.hasAttribute('data-pq') ? +$('#pq')?.textContent || 1 : 1;
  if (action === 'filters') { $('#filters').classList.toggle('open'); }
  if (action === 'menu') $('#mainnav').classList.toggle('open');
  if (action === 'retry') render();
  if (action === 'add') { cartAdd(id, qty); toast('Added to cart'); }
  if (action === 'buy') { cartAdd(id, qty); go('#/checkout'); }
  if (action === 'remove') { state.cart = state.cart.filter(i => i.id !== id); saveCart(); render(); }
  if (action === 'qty') { const l = state.cart.find(i => i.id === id); l.qty = Math.max(1, l.qty + +el.dataset.d); saveCart(); render(); }
  if (action === 'mfa-start') {
    el.disabled = true;
    const { data: f } = await db.auth.mfa.listFactors();
    for (const x of (f?.all || []).filter(x => x.status === 'unverified')) await db.auth.mfa.unenroll({ factorId: x.id }); // clear abandoned attempts
    // The app shows the store name and the account email, instead of the website address.
    const { data, error } = await db.auth.mfa.enroll({ factorType: 'totp', issuer: state.settings.store_name || 'Store', friendlyName: state.user.email || 'Authenticator' });
    if (error) { el.disabled = false; return toast(error.message, true); }
    $('#mfaBox').innerHTML = `<div class="panel" style="margin-top:14px"><h2>Scan this code</h2>
      <ol style="padding-left:18px;margin:8px 0"><li>Open your authenticator app and add an account.</li><li>Scan the code below, or type the key by hand.</li><li>Enter the 6-digit code the app shows.</li></ol>
      <div style="text-align:center"><img id="mfaQr" alt="QR code to scan" width="180" height="180"></div>
      <p style="word-break:break-all;text-align:center"><small>Key: <b>${esc(data.totp.secret)}</b></small></p><div id="mfaMsg"></div>
      <form id="mfaForm" novalidate><div class="field"><label for="mfaCode">6-digit code</label><input id="mfaCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></div><button class="btn pri sm">Turn on</button></form></div>`;
    $('#mfaQr').src = data.totp.qr_code; // set as a property: the code contains quotes that would break the page if pasted into HTML
    $('#mfaForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const ch = await db.auth.mfa.challenge({ factorId: data.id }); if (ch.error) return showMsg('#mfaMsg', ch.error.message);
      const vr = await db.auth.mfa.verify({ factorId: data.id, challengeId: ch.data.id, code: $('#mfaCode').value.trim() });
      if (vr.error) return showMsg('#mfaMsg', 'That code is not correct. Try again.');
      toast('Two-step verification is on'); render();
    });
  }
  if (action === 'mfa-off') {
    if (!confirm('Turn off two-step verification? Your account will be protected by your password only.')) return;
    const { data: f } = await db.auth.mfa.listFactors();
    const { error } = await db.auth.mfa.unenroll({ factorId: f.totp[0].id });
    error ? toast(error.message, true) : (toast('Two-step verification is off'), render());
  }
  if (action === 'logout-all') { await db.auth.signOut({ scope: 'global' }); await onSession(null); go('#/login'); toast('Signed out of all devices'); }
  if (action === 'addr-default') { await db.from('addresses').update({ is_default: false }).eq('user_id', state.user.id); await db.from('addresses').update({ is_default: true }).eq('id', id); render(); }
  if (action === 'addr-delete') { if (!confirm('Delete this address?')) return; const { error } = await db.from('addresses').delete().eq('id', id); error ? toast(error.message, true) : render(); }
  if (action === 'rebuy') { el.dataset.items.split(',').forEach(x => { const [pid, q] = x.split(':'); cartAdd(pid, +q || 1); }); toast('Items added to your cart'); go('#/cart'); }
  if (action === 'pay') { el.disabled = true; el.textContent = 'Redirecting…'; await startPayment(id); }
  if (action === 'logout') { await db.auth.signOut({ scope: 'local' }); await onSession(null); location.hash === '#/' ? render() : go('#/'); }
  if (action === 'resetpw') { try { await callResetFn({ action: 'request', email: state.user.email }); sessionStorage.setItem('resetEmail', state.user.email); go('#/resetcode'); } catch (err) { toast(err.message, true); } }
  if (action === 'wish') {
    if (state.needs2fa) { sessionStorage.setItem('after', location.hash); return go('#/verify2fa'); }
    if (!state.user) { sessionStorage.setItem('after', location.hash); return go('#/login'); }
    const on = state.wish.has(id);
    const { data: w } = await db.from('wishlists').select('id').eq('user_id', state.user.id).single();
    const { error } = on ? await db.from('wishlist_items').delete().eq('wishlist_id', w.id).eq('product_id', id)
      : await db.from('wishlist_items').insert({ wishlist_id: w.id, product_id: id });
    if (error) return toast(error.message, true);
    on ? state.wish.delete(id) : state.wish.add(id);
    $('#wishCount').textContent = state.wish.size;
    if (parseHash().path.startsWith('/wishlist')) return render();
    document.querySelectorAll(`[data-action="wish"][data-id="${id}"]`).forEach(b => {
      b.classList.toggle('on', !on); if (b.classList.contains('wishbtn')) b.textContent = on ? 'Add to wishlist' : 'Remove from wishlist';
    });
  }
});

$('#searchForm').addEventListener('submit', e => { e.preventDefault(); go('#/shop?q=' + encodeURIComponent($('#searchInput').value.trim())); });

/* ---------- session, settings, realtime ---------- */
async function onSession(user) {
  state.user = user;
  $('#accountLink').textContent = user ? 'My account' : 'Sign in';
  state.profile = null;
  // Password accepted, but this customer turned on two-step verification and has not entered the code yet.
  state.needs2fa = false;
  if (user) { const { data: aal } = await db.auth.mfa.getAuthenticatorAssuranceLevel(); state.needs2fa = !!aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2'; }
  if (user && !state.needs2fa) {
    const { data } = await db.from('profiles').select('full_name,phone').eq('id', user.id).maybeSingle();
    state.profile = data;
  }
  await loadWishlist();
  if (state.channel) { db.removeChannel(state.channel); state.channel = null; }
  if (user && !state.needs2fa) {
    // Customers see their own order updates live (RLS limits what is delivered).
    state.channel = db.channel('my-orders').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `user_id=eq.${user.id}` }, payload => {
      toast(`Order ${payload.new.order_number} is now ${payload.new.status}`);
      if (/^\/(account|order)/.test(parseHash().path)) render();
    }).subscribe();
  }
}

async function init() {
  // Paystack returns to SITE_URL?reference=...; move it into the hash router and clean the URL.
  const ref = new URLSearchParams(location.search).get('reference');
  if (ref) { history.replaceState(null, '', location.pathname); location.hash = '#/verify/' + encodeURIComponent(ref); }
  saveCart();
  try {
    const [s, c, b] = await Promise.all([
      db.from('store_settings').select('key,value'),
      db.from('categories').select('id,name,slug,image_url').eq('is_active', true).order('sort_order'),
      db.from('brands').select('id,name').eq('is_active', true).order('name'),
    ]);
    (s.data || []).forEach(r => { state.settings[r.key] = r.value; });
    state.cats = c.data || []; state.brands = b.data || [];
  } catch (e) { console.error(e); }
  const name = state.settings.store_name || 'TechHub';
  $('#logo').textContent = name; document.title = `${name} | Electronics & Gadgets`;
  renderFooter();
  const wa = String(POLICY.whatsapp || '').replace(/\D/g, '');
  if (/^\d{8,15}$/.test(wa)) document.body.insertAdjacentHTML('beforeend', `<a class="wa" href="https://wa.me/${wa}" target="_blank" rel="noopener">Chat on WhatsApp</a>`);
  $('#catMenu').innerHTML = state.cats.map(c => `<a href="#/shop?cat=${c.id}">${esc(c.name)}</a>`).join('');
  if (+state.settings.free_shipping_threshold > 0) $('#topbar').textContent = `Free delivery on orders over ${money(+state.settings.free_shipping_threshold)}`;
  else $('#topbar').hidden = true;

  db.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') return go('#/reset');
    if (event === 'INITIAL_SESSION') return; // init() handles the first render
    setTimeout(async () => { await onSession(session?.user || null); if (event !== 'TOKEN_REFRESHED') render(); }, 0);
  });
  const { data: { session } } = await db.auth.getSession();
  await onSession(session?.user || null);
  window.addEventListener('hashchange', render);
  render();
}
init();
