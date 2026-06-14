# SOS POS Google Reviews — Smart Fetch

**Version:** 4.3 · **Site:** app.sospos.com.au

A Tampermonkey script that shows your Google review rating and newest reviews inside SOS POS. Uses a two-step approach to stay well within free API limits: the cheap Places API checks for new reviews every hour (8am–6pm only), and SerpAPI is only called when a new review is actually detected.

---

## How It Works

```
Every 1 hour (8am–6pm only) → Places API checks review count
  ↓ count increased?
  YES → SerpAPI fetches newest reviews (uses 1 credit)
  NO  → do nothing until next hour
```

Both APIs stop **1 call before their monthly limit** to avoid any overage charges.

---

## Monthly API Budget

| API | Monthly Limit | Typical Usage (2 devices) |
|-----|--------------|--------------------------|
| Google Places (New) | 999 calls | ~620/month (10 checks/day × 31 days × 2 devices) |
| SerpAPI | 99 calls | Only used when a new review comes in |

> **8am–6pm restriction:** Checks only run during business hours. This halves API usage compared to running 24/7, and allows two devices to use the script simultaneously without exceeding the free tier.

> **1-before-limit protection:** The script stops at 999 Places calls and 99 SerpAPI calls — one before the billing threshold — to avoid any $2 overage charges.

---

## Features

- **Rating badge** in the SOS POS navbar — live star rating and review count
- **↻ Refresh button** — manually trigger a count check at any time
- **Countdown timer** — shows time until the next automatic check
- **Review popup** — click the rating badge to see the 3 newest reviews
- **New review banner** — notification popup when a new review is detected
- **API usage tracker** — shows Places and SerpAPI calls used this month
- **Operating hours display** — shows when the next check window opens

---

## Setup

### 1. Get API Keys

**Google Places API (New)** — Free
1. Go to **console.cloud.google.com**
2. Enable the **Places API (New)**
3. Create an API key and restrict it to the Places API

**SerpAPI** — Free tier: 100 searches/month
1. Sign up at **serpapi.com**
2. Copy your API key from the dashboard

### 2. Install the Script

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome
2. Click **Raw** on the `.user.js` file in this repo
3. Tampermonkey will prompt you to install — click **Install**
4. Open the script in Tampermonkey's editor
5. Replace the placeholder values on **line 16** and **line 18** with your API keys:

```js
const SERPAPI_KEY    = "YOUR_SERPAPI_KEY_HERE";     // line 16
const PLACES_API_KEY = "YOUR_PLACES_API_KEY_HERE";  // line 18
```

6. Save the script

---

## Using Multiple Scripts

If you're using several of the THVjQ Tampermonkey scripts, check the **Issues** tab — a multi-script addon that allows live updates and shared API key storage across all scripts is in progress. Leave a comment there and it'll be prioritised.

---

## Notes

- The Place ID is hardcoded to `ChIJh8rjhtkNnGsRXa7ZqVInOFs` (SOS Phone Repairs on Google Maps)
- Reviews and counters are stored in Tampermonkey's `GM_setValue` storage and persist across page reloads
- Monthly counters reset automatically at the start of each calendar month
- If both API limits are reached for the month, the script stops fetching and shows a warning in the popup — it will resume automatically the following month

---

## License

MIT
