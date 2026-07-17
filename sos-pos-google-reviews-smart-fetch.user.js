// SOS
// ==UserScript==
// @name         SOS POS Google Reviews - Smart Fetch v15
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  Checks review count every 1hr between 8am-6pm (Places API, free). Only calls SerpAPI when a NEW review is detected. Monthly caps: Places 999, SerpAPI 99.
// @author       SOS Phone Repairs
// @match        https://app.sospos.com.au/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      places.googleapis.com
// @connect      serpapi.com
// ==/UserScript==

(function() {
    'use strict';

    // ── Config (stored in Tampermonkey — click ⚙ in the popup to set) ────────
    const CFG_PLACE_ID    = '__grs_place_id__';
    const CFG_PLACES_KEY  = '__grs_places_key__';
    const CFG_SERP_KEY    = '__grs_serp_key__';

    function cfg(key, fallback) { return GM_getValue(key, fallback || ''); }
    function getPlaceId()   { return cfg(CFG_PLACE_ID,   'ChIJh8rjhtkNnGsRXa7ZqVInOFs'); }
    function getPlacesKey() { return cfg(CFG_PLACES_KEY, ''); }
    function getSerpKey()   { return cfg(CFG_SERP_KEY,   ''); }
    function hasPlacesKey() { return !!getPlacesKey(); }
    function hasSerpKey()   { return !!getSerpKey(); }

    function getPlacesUrl() {
        return `https://places.googleapis.com/v1/places/${getPlaceId()}`;
    }
    function getSerpUrl() {
        return `https://serpapi.com/search.json?engine=google_maps_reviews&place_id=${getPlaceId()}&sort_by=newestFirst&api_key=${getSerpKey()}`;
    }

    const CHECK_INTERVAL_MS    = 60 * 60 * 1000;
    const PLACES_MONTHLY_LIMIT = 999;
    const SERP_MONTHLY_LIMIT   = 99;

    // ── Utilities ─────────────────────────────────────────────────────────────

    function isWithinOperatingHours() {
        const hour = new Date().getHours();
        return hour >= 8 && hour < 18;
    }

    function normaliseReview(r) {
        const author = r.user?.name || r.authorAttribution?.displayName || r.author_name || 'Anonymous';
        let text = r.snippet || r.text || '';
        if (text && typeof text === 'object') text = text.text || '';
        if (!text) text = '(No written review)';
        let unixSeconds = null;
        if (r.iso_date)                       unixSeconds = Math.floor(new Date(r.iso_date).getTime() / 1000);
        else if (r.publishTime)               unixSeconds = Math.floor(new Date(r.publishTime).getTime() / 1000);
        else if (r.originalPublishTime)       unixSeconds = Math.floor(new Date(r.originalPublishTime).getTime() / 1000);
        else if (typeof r.time === 'number')  unixSeconds = r.time;
        return { author, text, unixSeconds, rating: r.rating || 0 };
    }

    function formatCountdown(ms) {
        if (ms < 0) return '00:00';
        const s = Math.floor(ms / 1000);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    function formatReviewDate(unixSeconds) {
        if (!unixSeconds) return 'Unknown date';
        return new Date(unixSeconds * 1000).toLocaleString('en-AU', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true,
        });
    }

    function starHTML(rating) {
        return Array.from({ length: 5 }, (_, i) =>
            `<span style="color:${i < rating ? '#f59e0b' : '#d1d5db'}">★</span>`
        ).join('');
    }

    function setError(msg) { GM_setValue('last_fetch_error', msg || ''); }

    function refreshPopupIfOpen() {
        const p = document.getElementById('tm-review-popup');
        if (!p) return;
        // Don't clobber the popup while the user is typing in the settings panel
        if (p.contains(document.activeElement)) return;
        p.remove();
        createPopup();
    }

    function getCurrentMonth() { return new Date().toISOString().substring(0, 7); }

    function getMonthlyCount(monthKey, countKey) {
        const cur = getCurrentMonth();
        return GM_getValue(monthKey, '') === cur ? GM_getValue(countKey, 0) : 0;
    }

    function incrementMonthlyCount(monthKey, countKey) {
        const cur  = getCurrentMonth();
        const n    = getMonthlyCount(monthKey, countKey);
        GM_setValue(monthKey, cur);
        GM_setValue(countKey, n + 1);
        return n + 1;
    }

    // ── Step 1: Places API count check ────────────────────────────────────────

    function checkReviewCount(force = false) {
        if (!hasPlacesKey()) {
            // Set error once — don't call refreshPopupIfOpen() here or it nukes the
            // settings form every second while the user is typing their keys in.
            setError('Places API key not set — click ⚙ in the review panel to configure.');
            return;
        }

        const now     = Date.now();
        const lastRun = GM_getValue('last_count_check', 0);
        if (!force && now - lastRun < CHECK_INTERVAL_MS) return;
        if (!force && !isWithinOperatingHours()) {
            console.log('[Reviews] Outside operating hours — skipping auto check');
            return;
        }

        const placesCallCount = getMonthlyCount('places_call_month', 'places_call_count_month');
        if (placesCallCount >= PLACES_MONTHLY_LIMIT) {
            setError(`Places API monthly limit reached (${PLACES_MONTHLY_LIMIT} calls). Resets next month.`);
            refreshPopupIfOpen();
            return;
        }

        console.log('[Reviews] Checking count via Places API…');
        GM_setValue('last_count_check', now);
        GM_setValue('count_check_status', 'checking');
        incrementMonthlyCount('places_call_month', 'places_call_count_month');

        GM_xmlhttpRequest({
            method:  'GET',
            url:     getPlacesUrl(),
            headers: {
                'X-Goog-Api-Key':   getPlacesKey(),
                'X-Goog-FieldMask': 'rating,userRatingCount',
            },
            onload(res) {
                GM_setValue('count_check_status', '');
                if (res.status !== 200) {
                    setError(`Count check failed: HTTP ${res.status}`);
                    refreshPopupIfOpen();
                    return;
                }
                let data;
                try { data = JSON.parse(res.responseText); } catch(e) { return; }
                if (data.error) { setError(`Places API: ${data.error.message}`); refreshPopupIfOpen(); return; }

                const newCount  = data.userRatingCount || 0;
                const newRating = data.rating || 0;
                const oldCount  = GM_getValue('stored_count', 0);

                GM_setValue('stored_rating', newRating);
                GM_setValue('stored_count',  newCount);

                console.log(`[Reviews] Count: ${oldCount} → ${newCount}${newCount > oldCount ? ' 🆕 NEW!' : ''}`);

                const ratingSpan = document.getElementById('tm-rating-display');
                if (ratingSpan) ratingSpan.innerHTML = `<span style="color:#f59e0b;margin-right:4px;">★</span>${newRating} (${newCount})`;

                if (newCount > oldCount) {
                    const diff = newCount - oldCount;
                    GM_setValue('new_review_alert', `${diff} new review${diff > 1 ? 's' : ''} detected!`);
                    fetchNewestViaSerpAPI();
                } else {
                    GM_setValue('new_review_alert', '');
                    refreshPopupIfOpen();
                }
            },
            onerror() {
                GM_setValue('count_check_status', '');
                setError('Network error on count check');
                refreshPopupIfOpen();
            },
        });
    }

    // ── Step 2: SerpAPI fetch ─────────────────────────────────────────────────

    function fetchNewestViaSerpAPI(manual = false) {
        if (!hasSerpKey()) {
            setError('SerpAPI key not set — click ⚙ in the review panel to configure.');
            refreshPopupIfOpen();
            return;
        }

        const serpCallCount = getMonthlyCount('serp_call_month', 'serp_call_count_month');
        if (serpCallCount >= SERP_MONTHLY_LIMIT) {
            setError(`SerpAPI monthly limit reached (${SERP_MONTHLY_LIMIT} calls). Resets next month.`);
            GM_setValue('serp_fetch_status', '');
            refreshPopupIfOpen();
            return;
        }

        console.log('[Reviews] Calling SerpAPI…');
        GM_setValue('serp_fetch_status', 'loading');
        setError('');
        refreshPopupIfOpen();

        const newCount = incrementMonthlyCount('serp_call_month', 'serp_call_count_month');
        console.log(`[Reviews] SerpAPI calls this month: ${newCount}`);

        GM_xmlhttpRequest({
            method: 'GET',
            url:    getSerpUrl(),
            onload(res) {
                GM_setValue('serp_fetch_status', '');
                if (res.status !== 200) {
                    setError(`SerpAPI HTTP ${res.status}: ${res.responseText.substring(0, 200)}`);
                    refreshPopupIfOpen();
                    return;
                }
                let data;
                try { data = JSON.parse(res.responseText); }
                catch(e) { setError(`SerpAPI JSON error: ${e.message}`); refreshPopupIfOpen(); return; }
                if (data.error) { setError(`SerpAPI error: ${data.error}`); refreshPopupIfOpen(); return; }

                const reviews = (data.reviews || []).map(normaliseReview).slice(0, 3);
                GM_setValue('stored_reviews', JSON.stringify(reviews));
                GM_setValue('last_fetch_error', '');
                GM_setValue('reviews_last_updated', Date.now());

                if (!manual) showNewReviewBanner();
                refreshPopupIfOpen();
            },
            onerror() {
                GM_setValue('serp_fetch_status', '');
                setError('SerpAPI network error — check Tampermonkey @connect permissions for serpapi.com');
                refreshPopupIfOpen();
            },
        });
    }

    function showNewReviewBanner() {
        document.getElementById('tm-new-review-banner')?.remove();
        const banner = document.createElement('div');
        banner.id = 'tm-new-review-banner';
        banner.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:99999;
            background:#0f172a;color:#e2e8f0;border-radius:10px;padding:12px 16px;
            font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,0.45);
            cursor:pointer;border-left:4px solid #f59e0b;`;
        banner.innerHTML = `<b style="color:#f59e0b;">⭐ New Google Review!</b><br>
            <span style="font-size:11px;color:#9ca3af;">Click to view</span>`;
        banner.onclick = () => { banner.remove(); createPopup(); };
        document.body.appendChild(banner);
        setTimeout(() => banner.isConnected && banner.remove(), 10000);
    }

    // ── Settings panel (inline in popup) ─────────────────────────────────────

    function buildSettingsPanel(popup) {
        const wrap = document.createElement('div');
        wrap.id = 'tm-settings-panel';
        wrap.style.cssText = `padding:12px 14px;border-bottom:1px solid #f3f4f6;
            background:#f9fafb;display:none;`;

        const missingKeys = !hasPlacesKey() || !getSerpKey();

        function field(labelText, gmKey, placeholder) {
            const block = document.createElement('div');
            block.style.cssText = 'margin-bottom:8px;';
            block.innerHTML = `<label style="font-size:10px;font-weight:700;color:#374151;display:block;margin-bottom:3px;">${labelText}</label>`;
            const input = document.createElement('input');
            input.type        = 'text';
            input.value       = GM_getValue(gmKey, '');
            input.placeholder = placeholder;
            input.autocomplete = 'off';
            input.style.cssText = `width:100%;padding:5px 8px;border:1px solid #e5e7eb;border-radius:6px;
                font-size:11px;color:#111;font-family:monospace;outline:none;background:#fff;`;
            input.onfocus = () => { input.style.borderColor = '#14b8a6'; };
            input.onblur  = () => { input.style.borderColor = '#e5e7eb'; };
            block.appendChild(input);
            return { block, input, gmKey };
        }

        const f1 = field('Place ID', CFG_PLACE_ID, 'ChIJ…');
        const f2 = field('Places API Key', CFG_PLACES_KEY, 'AIza…');
        const f3 = field('SerpAPI Key', CFG_SERP_KEY, 'Paste key…');

        const saveRow = document.createElement('div');
        saveRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:4px;';

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save Settings';
        saveBtn.style.cssText = `padding:6px 14px;background:#0d9488;color:#fff;border:none;
            border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;transition:background .15s;`;
        saveBtn.onmouseenter = () => { saveBtn.style.background = '#0f766e'; };
        saveBtn.onmouseleave = () => { saveBtn.style.background = '#0d9488'; };

        const saveMsg = document.createElement('span');
        saveMsg.style.cssText = 'font-size:11px;color:#10b981;';

        saveBtn.onclick = () => {
            GM_setValue(f1.gmKey, f1.input.value.trim());
            GM_setValue(f2.gmKey, f2.input.value.trim());
            GM_setValue(f3.gmKey, f3.input.value.trim());
            saveMsg.textContent = '✓ Saved — changes apply immediately';
            setTimeout(() => { saveMsg.textContent = ''; }, 3000);
        };

        saveRow.appendChild(saveBtn);
        saveRow.appendChild(saveMsg);

        wrap.appendChild(f1.block);
        wrap.appendChild(f2.block);
        wrap.appendChild(f3.block);
        wrap.appendChild(saveRow);

        if (missingKeys) {
            const warn = document.createElement('div');
            warn.style.cssText = `margin-top:8px;padding:6px 8px;background:#fffbeb;border:1px solid #fcd34d;
                border-radius:6px;font-size:10px;color:#92400e;`;
            warn.textContent = '⚠ API keys not configured — enter them above to enable review fetching.';
            wrap.appendChild(warn);
            wrap.style.display = 'block';
        }

        return wrap;
    }

    // ── Popup ─────────────────────────────────────────────────────────────────

    function createPopup() {
        const existing = document.getElementById('tm-review-popup');
        if (existing) { existing.remove(); return; }

        const reviews        = JSON.parse(GM_getValue('stored_reviews',       '[]'));
        const rating         = GM_getValue('stored_rating',        '...');
        const count          = GM_getValue('stored_count',         '...');
        const lastError      = GM_getValue('last_fetch_error',     '');
        const serpStatus     = GM_getValue('serp_fetch_status',    '');
        const countStatus    = GM_getValue('count_check_status',   '');
        const newAlert       = GM_getValue('new_review_alert',     '');
        const lastCountCheck = GM_getValue('last_count_check',     0);
        const reviewsUpdated = GM_getValue('reviews_last_updated', 0);
        const nextCheck      = lastCountCheck ? Math.max(0, lastCountCheck + CHECK_INTERVAL_MS - Date.now()) : 0;
        const isLoading      = serpStatus === 'loading' || countStatus === 'checking';
        const noReviews      = reviews.length === 0;

        const serpCallsMonth   = getMonthlyCount('serp_call_month',   'serp_call_count_month');
        const placesCallsMonth = getMonthlyCount('places_call_month', 'places_call_count_month');

        const popup = document.createElement('div');
        popup.id = 'tm-review-popup';
        Object.assign(popup.style, {
            position: 'fixed', top: '60px', left: '50%', transform: 'translateX(-50%)',
            zIndex: '99999', background: '#fff', border: '1px solid #e5e7eb',
            borderRadius: '14px', boxShadow: '0 8px 30px rgba(0,0,0,.15)',
            width: '430px', maxWidth: '95vw', fontFamily: 'system-ui,sans-serif', overflow: 'hidden',
        });

        // Header
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = `display:flex;justify-content:space-between;align-items:center;
            padding:14px 14px 12px;border-bottom:1px solid #f3f4f6;`;
        headerDiv.innerHTML = `
            <div>
                <span style="font-size:15px;font-weight:700;color:#111;">Google Reviews</span><br>
                <span id="tm-rating-display" style="font-size:13px;color:#f59e0b;font-weight:600;">
                    ★ ${rating}</span>
                <span style="font-size:12px;color:#6b7280;"> · ${count} reviews</span>
            </div>
        `;

        const btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display:flex;align-items:center;gap:5px;';

        const btnStyle = `background:#f3f4f6;border:none;cursor:pointer;border-radius:7px;
            width:30px;height:30px;display:flex;align-items:center;justify-content:center;
            font-size:14px;color:#6b7280;transition:background .12s,color .12s;`;

        const settingsBtn = document.createElement('button');
        settingsBtn.title = 'Settings';
        settingsBtn.style.cssText = btnStyle;
        settingsBtn.textContent = '⚙';
        settingsBtn.onmouseenter = () => { settingsBtn.style.background = '#0d2e2b'; settingsBtn.style.color = '#14b8a6'; };
        settingsBtn.onmouseleave = () => { settingsBtn.style.background = '#f3f4f6'; settingsBtn.style.color = '#6b7280'; };

        const refreshBtn = document.createElement('button');
        refreshBtn.title = 'Check count now';
        refreshBtn.style.cssText = btnStyle;
        refreshBtn.textContent = isLoading ? '⟳' : '↻';
        refreshBtn.onmouseenter = () => { refreshBtn.style.background = '#f3f4f6'; refreshBtn.style.color = '#111'; };
        refreshBtn.onmouseleave = () => { refreshBtn.style.background = '#f3f4f6'; refreshBtn.style.color = '#6b7280'; };

        const closeBtn2 = document.createElement('button');
        closeBtn2.style.cssText = `background:none;border:none;cursor:pointer;font-size:18px;color:#9ca3af;`;
        closeBtn2.textContent = '✕';

        btnGroup.appendChild(settingsBtn);
        btnGroup.appendChild(refreshBtn);
        btnGroup.appendChild(closeBtn2);
        headerDiv.appendChild(btnGroup);
        popup.appendChild(headerDiv);

        // Settings panel (collapsible)
        const settingsPanel = buildSettingsPanel(popup);
        popup.appendChild(settingsPanel);

        settingsBtn.onclick = e => {
            e.stopPropagation();
            const open = settingsPanel.style.display !== 'none';
            settingsPanel.style.display = open ? 'none' : 'block';
            settingsBtn.style.background = open ? '#f3f4f6' : '#0d2e2b';
            settingsBtn.style.color      = open ? '#6b7280' : '#14b8a6';
        };

        // Body
        const body = document.createElement('div');
        body.style.cssText = 'padding:12px 14px;';

        // Stats row
        body.innerHTML += `
            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;
                        padding:8px 10px;margin-bottom:10px;font-size:11px;color:#6b7280;line-height:2;">
                <div>⏱ Next check: <b style="color:#111;">${formatCountdown(nextCheck)}</b></div>
                <div>🗺 Places API this month:
                    <b style="color:${placesCallsMonth >= PLACES_MONTHLY_LIMIT ? '#ef4444' : placesCallsMonth > 900 ? '#f59e0b' : '#111'};">
                        ${placesCallsMonth}/${PLACES_MONTHLY_LIMIT}
                    </b>${placesCallsMonth >= PLACES_MONTHLY_LIMIT ? ' <span style="color:#ef4444;font-weight:700;">— LIMIT</span>' : ''}
                </div>
                <div>📊 SerpAPI this month:
                    <b style="color:${serpCallsMonth >= SERP_MONTHLY_LIMIT ? '#ef4444' : serpCallsMonth > 80 ? '#f59e0b' : '#111'};">
                        ${serpCallsMonth}/${SERP_MONTHLY_LIMIT}
                    </b>${serpCallsMonth >= SERP_MONTHLY_LIMIT ? ' <span style="color:#ef4444;font-weight:700;">— LIMIT</span>' : ''}
                </div>
                ${reviewsUpdated ? `<div>📅 Updated: <b style="color:#111;">${formatReviewDate(reviewsUpdated / 1000)}</b></div>` : ''}
            </div>
        `;

        if (newAlert) {
            body.innerHTML += `
                <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;
                            padding:8px 10px;margin-bottom:10px;font-size:12px;color:#92400e;font-weight:600;">
                    ⭐ ${newAlert}
                </div>`;
        }

        if (lastError) {
            body.innerHTML += `
                <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;
                            padding:8px 10px;margin-bottom:10px;font-size:11px;color:#b91c1c;line-height:1.5;">
                    <b>⚠ Error</b><br>${lastError}
                </div>`;
        }

        const cards = document.createElement('div');
        cards.id = 'tm-review-cards';

        if (isLoading) {
            cards.innerHTML = `<p style="color:#6b7280;font-size:13px;text-align:center;margin:12px 0;">
                ⟳ ${serpStatus === 'loading' ? 'Fetching newest reviews…' : 'Checking review count…'}</p>`;
        } else if (noReviews) {
            cards.innerHTML = `<p style="color:#6b7280;font-size:13px;text-align:center;margin:8px 0 4px;">
                No reviews loaded yet.<br>
                <span style="font-size:11px;">Auto-loads when a new review comes in, or click below.</span>
            </p>`;
            const loadBtn = document.createElement('div');
            loadBtn.innerHTML = `
                <button id="tm-force-load"
                    style="width:100%;padding:9px;background:#4285f4;color:#fff;border:none;
                           border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;margin-top:6px;">
                    ⬇ Load Reviews Now (uses 1 SerpAPI call)
                </button>`;
            cards.appendChild(loadBtn);
        } else {
            reviews.forEach((review, idx) => {
                const card = document.createElement('div');
                card.style.cssText = `padding:10px 0;${idx < reviews.length - 1 ? 'border-bottom:1px solid #f3f4f6;' : ''}`;
                card.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
                        <span style="font-weight:600;font-size:13px;color:#111;">${review.author}</span>
                        <span style="font-size:11px;color:#9ca3af;white-space:nowrap;margin-left:8px;">
                            ${formatReviewDate(review.unixSeconds)}</span>
                    </div>
                    <div style="margin-bottom:5px;">${starHTML(review.rating)}</div>
                    <p style="font-size:12px;color:#374151;margin:0;line-height:1.5;
                               overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;">
                        ${review.text}</p>
                `;
                cards.appendChild(card);
            });
        }

        body.appendChild(cards);
        popup.appendChild(body);
        document.body.appendChild(popup);

        closeBtn2.onclick = e => { e.stopPropagation(); popup.remove(); };
        refreshBtn.addEventListener('click', e => {
            e.stopPropagation();
            checkReviewCount(true);
            setTimeout(refreshPopupIfOpen, 400);
        });
        document.getElementById('tm-force-load')?.addEventListener('click', e => {
            e.stopPropagation();
            fetchNewestViaSerpAPI(true);
        });

        setTimeout(() => {
            document.addEventListener('click', function handler(e) {
                if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', handler); }
            });
        }, 0);
    }

    // ── Inject UI into SOS POS nav ────────────────────────────────────────────

    function injectUI() {
        const storeIcon = document.querySelector('svg.lucide-store');
        if (!storeIcon) return;
        const container      = storeIcon.parentElement;
        const lastCountCheck = GM_getValue('last_count_check', 0);
        const timeLeft       = lastCountCheck ? Math.max(0, lastCountCheck + CHECK_INTERVAL_MS - Date.now()) : 0;

        let ratingSpan = document.getElementById('tm-rating-display');
        if (!ratingSpan) {
            ratingSpan = document.createElement('div');
            ratingSpan.id = 'tm-rating-display';
            Object.assign(ratingSpan.style, {
                display: 'inline-flex', alignItems: 'center', marginRight: '8px',
                padding: '2px 8px', backgroundColor: '#fef3c7', borderRadius: '6px',
                border: '1px solid #fcd34d', fontSize: '12px', fontWeight: '600',
                color: '#92400e', cursor: 'pointer', userSelect: 'none', transition: 'background-color 0.15s',
            });
            ratingSpan.title = 'Click to see recent reviews';
            ratingSpan.addEventListener('mouseenter', () => { ratingSpan.style.backgroundColor = '#fde68a'; });
            ratingSpan.addEventListener('mouseleave', () => { ratingSpan.style.backgroundColor = '#fef3c7'; });
            ratingSpan.addEventListener('click', e => { e.stopPropagation(); createPopup(); });
            container.insertBefore(ratingSpan, storeIcon);
        }
        const rating = GM_getValue('stored_rating', '...');
        const count  = GM_getValue('stored_count',  '...');
        ratingSpan.innerHTML = `<span style="color:#f59e0b;margin-right:4px;">★</span>${rating} (${count})`;

        let refreshBtn = document.getElementById('tm-refresh-btn');
        if (!refreshBtn) {
            refreshBtn = document.createElement('button');
            refreshBtn.id = 'tm-refresh-btn';
            refreshBtn.textContent = '↻';
            refreshBtn.title = 'Check for new reviews now';
            Object.assign(refreshBtn.style, {
                fontSize: '13px', color: '#9ca3af', background: 'none', border: 'none',
                cursor: 'pointer', marginRight: '2px', padding: '0 2px', lineHeight: '1',
            });
            refreshBtn.addEventListener('mouseenter', () => { refreshBtn.style.color = '#f59e0b'; });
            refreshBtn.addEventListener('mouseleave', () => { refreshBtn.style.color = '#9ca3af'; });
            refreshBtn.addEventListener('click', e => { e.stopPropagation(); checkReviewCount(true); });
            container.insertBefore(refreshBtn, storeIcon);
        }

        let timerSpan = document.getElementById('tm-refresh-timer');
        if (!timerSpan) {
            timerSpan = document.createElement('span');
            timerSpan.id = 'tm-refresh-timer';
            Object.assign(timerSpan.style, {
                fontSize: '10px', color: '#9ca3af', marginRight: '2px', fontFamily: 'monospace',
            });
            container.insertBefore(timerSpan, refreshBtn);
        }
        timerSpan.textContent = formatCountdown(timeLeft);
    }

    checkReviewCount();
    injectUI();
    setInterval(() => { checkReviewCount(); injectUI(); }, 1000);

})();
