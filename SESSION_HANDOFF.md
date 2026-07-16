# Digitalcoo CRM — MERN Rebuild — Session Handoff

## Where this project came from

This repo started as a single 2,488-line vanilla-JS `index.html` prototype (still present in the repo root, alongside `joydata.js`) for **Digitalcoo Technologies LLC**, an e& (Etisalat) Authorised Channel Partner in the UAE. It used `localStorage` as its "database" and covered: DSR (agent calling list), Sales Pipeline, Back Office/Orders, MIS & Targets, HR, Payroll, Accounting, AI Reports, and Admin — across 8 roles. The user (Huzaifa, senior dev, Dubai) asked to rebuild it as a real MERN app: **React + Vite** frontend, **Node/Express + MongoDB** backend. Read the original `index.html` (`seed()` function around line 275–456) if you need to see exact legacy field names/business rules for a module not yet ported.

**Read `G:\My Drive\KGC\projects\digicoo-crm\index.html`** (old prototype location) for reference on any module not yet built — it has the full seed data shapes, UI copy, and business rules for HR, Payroll, Accounting, and Admin that haven't been ported yet.

## Critical environment facts

- **Project now lives at `D:\projects\digitalcoo-crm`**, NOT the original `G:\My Drive\KGC\projects\digicoo-crm`. It was moved because that path is a Google Drive Desktop sync folder — `npm install` there reliably fails with `EBADF`/`EPERM`/`ENOTEMPTY` errors from Drive locking files during install. **Never run `npm install` under `G:\My Drive\...`.** The `G:\` copy still exists as an untouched backup (has the original `index.html`, `joydata.js`, and a stale `.claude/launch.json` pointing at the D: drive) — do not delete it without asking.
- Git history was preserved in the move (`cp -a` including `.git`). The D:\ copy is a fully independent git repo (not a worktree of the G:\ one).
- **MongoDB Community Server 8.3.4** is installed natively on Windows (not Docker — user explicitly rejected Docker for this app) and runs as a Windows service (`Get-Service -Name MongoDB`). Connection string: `mongodb://127.0.0.1:27017/digitalcoo_crm`.
- **Server runs on port 5601**, not 5600 — 5600 was already occupied by an unrelated process (PID 32552) on the user's machine when we tried to start it. Per explicit user instruction: **never kill unknown processes to free a port — always move to the next free port instead** (5600→5601 pattern). If 5601 is ever occupied too, check with `Get-NetTCPConnection -LocalPort <port>` and bump again; update `server/.env` (`PORT=`), `client/.env` (`VITE_API_URL=`), and **both** `.claude/launch.json` files (`D:\projects\digitalcoo-crm\.claude\launch.json` and `G:\My Drive\KGC\projects\digicoo-crm\.claude\launch.json`).
- **Client runs on port 5173** (Vite default), CORS-locked to it via `CLIENT_ORIGIN` in server `.env`.
- **The Preview MCP tool's project root is locked to wherever the session started** — if a fresh session starts in `D:\projects\digitalcoo-crm`, this problem goes away and `preview_start`/`preview_screenshot`/etc. should work normally against `.claude/launch.json` in that folder. (In the prior session, root was stuck on the old `G:\` path even after the move, which is the whole reason this handoff exists — restart from `D:\` to avoid it.)
- **Chrome extension (`claude-in-chrome` MCP) was disconnected** at the end of the last session — visual browser verification of the frontend was not completed. That's the first thing to retry in the new session.
- Both dev servers may already be running in the background from the last session (`npm run dev` in `server/` and `client/`, started via Bash with `disown`) — check `Get-NetTCPConnection -LocalPort 5601` / `5173` before starting new ones.

## Tech stack (decided, do not re-litigate lightly)

- **Frontend:** React + Vite, **Mantine v9** (UI shell: AppShell, Table, forms, notifications) + **raw `@tanstack/react-table`** (headless table logic) + **`@tanstack/react-query`** (server state/caching) + **`react-router-dom`** + **`lucide-react`** (icons, chosen consistently over Tabler icons) + **`zod`** (validation, shared shape with backend) + **`@mantine/form`**.
  - **`mantine-react-table` was deliberately rejected**: its only stable release (1.3.4) requires Mantine v6 (old); the version supporting modern Mantine (2.0.0-beta.9) is still beta and caps at Mantine v7, while we're on v9. Rather than pin to old/beta packages for a finance/payroll app, we built a thin reusable `DataTable.jsx` wrapper ourselves around raw TanStack Table + Mantine primitives (`client/src/components/DataTable.jsx`). This is the pattern every module's list screen should reuse.
- **Backend:** Node + Express (CommonJS, no TypeScript per user's global CLAUDE.md rules), Mongoose, **bcryptjs**, **JWT in an httpOnly cookie** (not localStorage — immune to XSS token theft), **multer 2.x** (upgraded from 1.x due to CVEs — user wants zero security bugs), **zod**, **helmet**, **express-rate-limit** (on login), **express-mongo-sanitize**, **cors** (locked to `CLIENT_ORIGIN`).
- **Real-time notifications: polling, NOT WebSockets.** User explicitly said they've had repeated reliability problems with WebSockets (missed notifications, connection issues) and wants zero chance of a missed notification. Long discussion concluded: durable-log-in-Mongo + cheap index-covered count polling (`GET /notifications/count`, default 20s via `NOTIFY_POLL_MS`) is the reliable, simple answer for this app's scale (dozens–low hundreds of concurrent users). TanStack Query's `refetchInterval` handles it; `refetchIntervalInBackground` defaults to false so hidden tabs don't poll. Full notification list is only fetched when the user opens the bell (`GET /notifications?afterSeq=`, catch-up cursor pattern — client tracks `seq`, so nothing can be permanently missed even after being offline for hours). **If "instant" push is wanted later**, Socket.IO or SSE can be layered on top purely as a speed optimization — the durable-log + catch-up design underneath never changes and remains the correctness guarantee. Do not build this unless asked.

## The three architecture decisions that matter most (do not casually change these)

1. **Hierarchy is denormalized, not walked recursively.** `User.managerChain` is a stamped array `[immediateManager, theirManager, ...]` up to Sales Head, rebuilt via `services/hierarchy.js`. Every DSR/Pipeline/Order record stamps `agentId/tlId/teamHeadId/salesHeadId` **at creation time** from the creating agent's current `managerChain`. This makes every rollup query (a Team Leader's DSRs, a Teams Head's pipeline, etc.) a single indexed Mongo query instead of a recursive tree walk — critical at the 100k+ call-log scale the user described. See `scopeFilter()` in `dsrController.js`/`pipelineController.js`/`orderController.js` for the query pattern (`agent` sees own only; everyone above sees `$or` of all four hierarchy fields matching their own `_id`; `admin` sees all).

2. **Point-in-time role/manager history is tracked separately (`AssignmentHistory` model).** This was a mid-session addition the user explicitly requested: "we need to maintain the time frame an agent was assigned to a specific team leader... roles will be assignable, and must keep record." `AssignmentHistory` (`server/models/AssignmentHistory.js`) has one row per (role, reportsTo) period a user held, with `startDate`/`endDate` (null = current). **The only correct way to change a user's role or manager is `services/hierarchy.js → reassignUser()`** — it closes the open history row, opens a new one, updates the live `User` doc, and cascades `managerChain` rebuilds to all descendants. Never mutate `user.role` or `user.reportsTo` directly anywhere else — history would go stale. `GET /users/:id/history` exposes this for admin/HR UI (not yet built).

3. **Every list endpoint uses the same paginated contract.** `utils/pagination.js`: `parsePagination(query)` reads `page`/`limit`/`sort` from query string, caps `limit` at `PAGE_SIZE_MAX` (env, default 200; default page size 50 via `PAGE_SIZE_DEFAULT`). `buildPageResponse(data, totalRowCount, page, limit)` returns `{ data, meta: { totalRowCount, page, limit } }` — this exact shape is what the frontend's `usePagedList` hook (`client/src/hooks/usePagedList.js`) and `DataTable` component expect. Every future module's list endpoint (HR employees, MIS rows, payroll runs, accounting ledger, etc.) must follow this same contract so the frontend pattern is copy-paste reusable. `usePagedList` also handles: debounced search (300ms via `useDebouncedValue`, so typing doesn't refetch per keystroke) and `placeholderData: keepPreviousData` (old page stays visible during refetch instead of flashing empty — a TanStack Query v5 gotcha the user was warned about).

## What's fully built and verified working (backend confirmed via curl; frontend built but not yet visually verified due to Chrome disconnect)

**Backend (`server/`), all wired into `app.js`:**
- Config: `config/env.js` (all system-level `.env` reads with `required()` guard), `config/db.js`.
- `utils/constants.js` — single source of truth for `ROLES` (8 roles), `ACCESS_DEFAULT`/`EDIT_ACCESS_DEFAULT` (per-role view/edit module lists, ported from the prototype), `MODULES`, `CALL_STATUS`, `PIPE_STAGES`, `ORDER_STATUS`.
- Auth: `POST /auth/login` (rate-limited 20/15min), `POST /auth/logout`, `GET /auth/me` — httpOnly+sameSite=lax+secure(prod) cookie, 7-day JWT. `/auth/me` and `/auth/login` responses include `user.modules`/`user.editModules` (server-resolved via `services/permissions.js`, so the client never re-implements RBAC logic — it just renders/hides based on these arrays; **the server still enforces the real check on every route via `middlewares/rbac.js`**, client-side hiding is UX only).
- RBAC: `models/Permission.js` (singleton doc, runtime-editable — not yet exposed via an admin API endpoint, that's remaining work), `services/permissions.js` (in-memory cache, loaded on boot), `middlewares/rbac.js` (`requireModule(key, {edit})`, `requireRole(...)`).
- Users: full CRUD at `/users` (admin/hr only) including `reassignUser` flow and `/users/:id/history`.
- DSR: `/dsr` — scoped list with pagination/search/status filter, create (auto hierarchy-stamps from creator), status update (agent-owns-or-admin check), history array on every record.
- Pipeline/Orders workflow (`services/workflow.js` — the single state machine, matches the exact flow the user described: Agent DSR → "Interested" → `convertToPipeline` → notifies TL → TL `tlApprove`/`tlReject`/`tlEscalate` → approve auto-creates an `Order` and notifies all `backoffice` role users + the agent → Back Office `updateOrderStatus` notifies agent+TL). Routes: `/pipeline` (list/create/approve/reject/escalate), `/orders` (list/status update).
- Notifications: durable log (`models/Notification.js`, monotonic `seq` via `models/Counter.js`), `services/notify.js` (write-first), routes `/notifications` (`/count`, `/`, `/:id/read`, `/read-all`).
- `seed.js` — wipes and reseeds: 16 users (full org chart: Admin, Amir Qadri/sales_head, Sana/teams_head, Joy+Maria+Rahul/team_leaders, 7 agents, Ansari/backoffice, ABC/accountant, Fatima/hr), 300 DSR records, ~37 pipeline deals (from "Interested" DSRs), ~19 auto-generated orders. **Demo login pattern: `username / username@2026`** (e.g. `hira/hira@2026`, `admin/admin@2026`, `joy/joy@2026`). Full list printed at end of `seed.js` output.
- Verified via curl: login sets cookie correctly, `/auth/me` round-trips, `/dsr` list correctly scopes to the logged-in agent (43 of Hira's own 300÷7≈43 records), `/notifications/count` returns correct unread count. **This proves the core backend architecture works end-to-end.**

**Frontend (`client/`), built but NOT yet visually verified in a browser:**
- `main.jsx` — MantineProvider (light default) + Notifications (bottom-center, per user's global Shopify-style toast rule) + QueryClientProvider + BrowserRouter + AuthProvider.
- `context/AuthContext.jsx` — `/auth/me` on mount, listens for a global `auth:unauthorized` event (dispatched by `api/axios.js`'s response interceptor on any 401) to drop session and redirect.
- `components/ProtectedRoute.jsx` — gates by login + optional `module` prop checked against `user.modules`.
- `components/AppLayout.jsx` — Mantine AppShell with collapsible sidebar (nav items filtered by `user.modules`, from `constants/nav.js`), header with `NotificationBell` + user menu/logout.
- `components/NotificationBell.jsx` + `hooks/useNotifications.js` — implements the polling design above.
- `components/DataTable.jsx` — the reusable table wrapper (see architecture decision #3).
- `hooks/usePagedList.js` — the reusable paged-list state hook (see architecture decision #3).
- `features/auth/LoginPage.jsx` — plain Mantine form, calls `AuthContext.login`.
- `features/dsr/DsrPage.jsx` — **the reference module implementation**: uses `DataTable` + `usePagedList`, inline status Select for the owning agent (calls `PATCH /dsr/:id/status`), "To Pipeline" button for Interested+not-yet-converted rows (calls `convertToPipeline`), a Mantine Modal + `@mantine/form` for logging a new call. **Copy this file's structure for every other module's list page.**
- `App.jsx` — routes: `/login` public; everything else behind `ProtectedRoute`; `/dsr` built, every other nav item (`dash`, `pipeline`, `backoffice`, `mis`, `hr`, `payroll`, `accounting`, `ai`, `admin`) currently renders `<ComingSoon label="..."/>` gated by its own `ProtectedRoute module=`.
- `.env` files exist for both `server/` and `client/` with all agreed system-level keys (see below) — **do not put business logic constants in `.env`**, only system/infra values.

## `.env` keys already established (the pattern to follow for anything new)

```
# server/.env
PORT=5601
MONGO_URI=mongodb://127.0.0.1:27017/digitalcoo_crm
JWT_SECRET=<64-byte hex, already generated>
JWT_EXPIRES=7d
NODE_ENV=development
CLIENT_ORIGIN=http://localhost:5173
PAGE_SIZE_DEFAULT=50
PAGE_SIZE_MAX=200
UPLOAD_DIR=uploads
UPLOAD_MAX_KB=800
BCRYPT_ROUNDS=12
```
```
# client/.env
VITE_API_URL=http://localhost:5601
VITE_PAGE_SIZE=50
VITE_NOTIFY_POLL_MS=20000
```

## What's NOT built yet (remaining task list, in the order the original plan laid out)

1. **First thing to do in the new session:** reconnect Chrome extension, visually verify login → DSR list → pagination → create DSR → status change → convert to pipeline → notification appears in bell. Fix any bugs found (this has never been visually tested).
2. File uploads (multer, local disk `/uploads`) — decided but not implemented; needed for HR compliance docs (passport/visa/EID images) and DSR chat attachments.
3. **Dashboard** module (`/`) — currently a placeholder.
4. **MIS & Targets** — target vs submission vs activation rollups, team-leader roll-ups, CSV export. This is where MongoDB aggregation pipelines matter (see original architecture discussion: precompute daily summary docs for scale rather than aggregating live over 100k+ rows).
5. **HR** module — employee master (extends `User`/`compliance`/`docs` sub-schemas already on the model), passport/visa/EID compliance badges (expiring/expired logic existed in the old prototype's `seed()`), active/inactive, team assignment (uses `reassignUser`).
6. **Payroll** — payroll runs, employee ledger (advances/loans/deductions), WPS-style export, gratuity accrual. None of this has models yet.
7. **Accounting** — P&L, VAT (5%), Corporate Tax (9%), Chart of Accounts, cheques (PDC lifecycle), invoices/accountTx. None of this has models yet. Reference old `index.html` seed() for exact field shapes (`accounts`, `accountTx`, `cheques`, `invoices`).
8. **AI Reports** — daily/weekly/monthly generated summaries with download. Was a stubbed/fake feature in the prototype; needs a real design decision (actual LLM call vs. templated summary) — ask the user before building.
9. **Admin/Settings** — permissions editor UI (backend `Permission` model exists, needs `GET/PATCH /permissions` routes + admin UI to edit `byRole`/`editByRole`/`userOverrides` at runtime), user management UI (backend CRUD exists), products/plans management (no model yet — old prototype had a `PRODUCTS` catalog feeding pipeline/order `cat`/`product` fields, currently hardcoded inline in `DsrPage.jsx`'s convert call and `seed.js`).
10. Chat threads per DSR (`threads` in old prototype) — not started, no model.
11. Notification real-time push upgrade (Socket.IO/SSE on top of the polling foundation) — explicitly deferred, only build if asked.

## User's working style / standing preferences to respect

- Wants terse, direct answers generally, but this session has been in an explanatory/architectural-discussion mode by the user's own choice (asked for "complete overview," "what do you say," etc.) — match whichever mode the user is currently in.
- Global CLAUDE.md rules apply throughout: no TypeScript on backend, single quotes, camelCase/PascalCase conventions, try/catch in every route handler (done throughout), no unused imports, no commented-out code, both client+server validation, axios wrapped in try/catch, Shopify-style bottom-center toasts (red=error, dark=info — already wired in `main.jsx`/`Notifications`), always generate ready-to-paste `.env` after any backend setup work, never hardcode domains/ports/secrets.
- **Explicit standing rule discovered this session: never kill an unrecognized process to free a port — always move to the next free port instead**, and propagate the port change through every `.env`/`launch.json` that references it.
- **Never use Docker** for this app.
- User cares a lot about: no security bugs, real-time notification reliability (zero tolerance for missed notifications), pagination/scale readiness for 100k+ records, and historical accuracy of the org hierarchy for reporting/exports.
- Confirmed-good decisions the user affirmed mid-session (don't re-ask): Mantine (not shadcn/AntD) for UI, TanStack Table + Query for data grids (raw, not mantine-react-table, once the version conflict surfaced), polling over WebSockets for notifications, numbered pagination with first/last-page jump (`Pagination withEdges` in Mantine) over infinite scroll, lucide-react over Tabler icons, `.env` reserved for system-level config only.

## Immediate next step recommendation for the new session

Start by confirming the working directory is `D:\projects\digitalcoo-crm`, check whether the dev servers from the last session are still running (`Get-NetTCPConnection -LocalPort 5601` and `-LocalPort 5173`), start them via `preview_start` if not (should now work correctly since the project root will match), reconnect the Chrome extension, and run through the DSR module end-to-end visually before continuing to build the remaining modules — the backend is solid and verified, but nothing has been seen rendered in an actual browser yet.
