const { z } = require('zod');
const Dsr = require('../models/Dsr');
const Order = require('../models/Order');
const User = require('../models/User');
const { nextSeq } = require('../models/Counter');
const { parsePagination, buildPageResponse } = require('../utils/pagination');
const { notify } = require('../services/notify');
const { CALL_STATUS, NOT_CONNECTED_STATUSES } = require('../utils/constants');
const { sendXlsx, parseXlsxBuffer, cell, resolveAgentFromRow } = require('../utils/importExport');
const { regexOr } = require('../utils/search');
const AppError = require('../utils/AppError');
const { logActivity, diffFields } = require('../utils/activityLog');
const { attachIsNew } = require('../services/recordViews');

const DSR_FIELD_LABELS = { date: 'Date', company: 'Company', building: 'Building', contactNo: 'Contact No', email: 'Email', customer: 'Customer', status: 'Status', remarks: 'Remarks' };

function connectedFor(status) {
  return NOT_CONNECTED_STATUSES.includes(status) ? 'NO' : 'YES';
}

// A DSR stays editable through its whole life in the Sales Pipeline - `convertedToPipeline` flips
// the instant it enters the pipeline (10%-Prospect), which is too early to lock the original call
// record. The real cutoff is once the deal is actually sent to Back Office - an Order exists for
// it (see services/workflow.js ensureOrderForPipeline, fired by TL approval or reaching 100%).
async function isSentToBackOffice(dsr) {
  if (!dsr.convertedToPipeline) return false;
  return Order.exists({ dsrNo: dsr.dsrNo });
}

// At least 7 digits after stripping formatting - loose enough for local/international UAE
// numbers, tight enough to catch the classic Excel gotcha where a leading 0 gets silently
// dropped because the phone-number column was typed/saved as a numeric cell.
const contactNoSchema = z
  .string()
  .trim()
  .min(1, 'Contact No is required')
  .refine((v) => v.replace(/\D/g, '').length >= 7, 'Contact No looks too short — check it wasn\'t stored as a number and lost a leading 0');

const emailSchema = z.string().trim().refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Not a valid email address');

const createSchema = z.object({
  date: z.string().min(1),
  company: z.string().trim().min(1),
  building: z.string().optional().default(''),
  contactNo: contactNoSchema,
  email: emailSchema.optional().default(''),
  customer: z.string().optional().default(''),
  status: z.enum(CALL_STATUS),
  remarks: z.string().optional().default(''),
  connected: z.enum(['YES', 'NO']).optional(),
});

const statusUpdateSchema = z.object({
  status: z.enum(CALL_STATUS),
  remarks: z.string().optional(),
});

const updateSchema = z.object({
  date: z.string().min(1).optional(),
  company: z.string().trim().min(1).optional(),
  building: z.string().optional(),
  contactNo: contactNoSchema.optional(),
  email: emailSchema.optional(),
  customer: z.string().optional(),
  status: z.enum(CALL_STATUS).optional(),
  remarks: z.string().optional(),
});

// Scopes the base filter to what this user is allowed to see:
// agent -> own records only; team_leader/teams_head/sales_head -> their subtree via managerChain;
// admin -> everything.
function scopeFilter(user) {
  if (user.role === 'admin') return {};
  if (user.role === 'agent') return { agentId: user._id };
  // Anyone above agent level sees records where they appear anywhere in the stamped hierarchy.
  return {
    $or: [{ tlId: user._id }, { teamHeadId: user._id }, { salesHeadId: user._id }, { agentId: user._id }],
  };
}

// Who this user is allowed to log a DSR call for - powers the Agent selector shown to anyone
// above agent level (see final note on this feature: "any higher employee can also do it").
// Admin sees everyone active; anyone else sees their own subtree (via managerChain) plus
// themselves, matching the exact scope `create` already enforces server-side.
async function loggableEmployees(req, res, next) {
  try {
    const filter =
      req.user.role === 'admin'
        ? { active: true }
        : { active: true, $or: [{ _id: req.user._id }, { managerChain: req.user._id }] };
    const employees = await User.find(filter).select('employeeId name role').sort({ name: 1 }).lean();
    res.json({ data: employees });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query);
    const filter = { ...scopeFilter(req.user) };

    if (req.query.status) filter.status = req.query.status;
    // agentId query param only narrows within what scopeFilter already allows — it must never
    // widen access, so it's applied as an $and clause on top of the scope, not an override.
    if (req.query.agentId) filter.$and = [...(filter.$and || []), { agentId: req.query.agentId }];
    if (req.query.search) {
      const re = new RegExp(req.query.search.trim(), 'i');
      // agentId is a reference, not a plain field — a search for the agent's name has to
      // resolve to their _id(s) first before it can be OR'd in alongside the plain-text fields.
      const matchingAgents = await User.find({ name: re }).select('_id').lean();
      filter.$and = [
        {
          $or: [
            ...regexOr(req.query.search.trim(), ['company', 'contactNo', 'customer', 'dsrNo', 'building', 'remarks', 'status']),
            { agentId: { $in: matchingAgents.map((u) => u._id) } },
          ],
        },
      ];
    }

    const [data, totalRowCount] = await Promise.all([
      Dsr.find(filter).sort(sort).skip(skip).limit(limit).populate('agentId', 'name').lean(),
      Dsr.countDocuments(filter),
    ]);

    // See isSentToBackOffice above - batched here instead of per-row to avoid an N+1 query.
    const convertedDsrNos = data.filter((d) => d.convertedToPipeline).map((d) => d.dsrNo);
    const sentOrders = convertedDsrNos.length ? await Order.find({ dsrNo: { $in: convertedDsrNos } }).select('dsrNo').lean() : [];
    const sentSet = new Set(sentOrders.map((o) => o.dsrNo));
    data.forEach((d) => { d.sentToBackOffice = sentSet.has(d.dsrNo); });

    const withIsNew = await attachIsNew(req.user._id, 'dsr', data);
    res.json(buildPageResponse(withIsNew, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const body = parsed.data;

    const agent = req.user.role === 'agent' ? req.user : await User.findById(req.body.agentId);
    if (!agent) throw new AppError('Agent not found', 400);

    if (req.user.role !== 'agent' && req.user.role !== 'admin') {
      const inScope = [agent.managerChain?.[0], agent.managerChain?.[1], agent.managerChain?.[2], agent._id]
        .map((id) => String(id)).includes(String(req.user._id));
      if (!inScope) throw new AppError('You cannot log a call for an agent outside your team', 403);
    }

    const seq = await nextSeq('dsr');
    const dsrNo = 'DSR-' + String(seq).padStart(5, '0');
    const chain = agent.managerChain || [];

    const dsr = await Dsr.create({
      dsrNo,
      ...body,
      connected: body.connected || connectedFor(body.status),
      agentId: agent._id,
      tlId: chain[0] || null,
      teamHeadId: chain[1] || null,
      salesHeadId: chain[2] || null,
      history: [{ userId: req.user._id, text: `DSR created · status set to ${body.status}` }],
    });

    if (chain[0]) await notify(chain[0], `New DSR ${dsrNo} by ${agent.name} — ${body.company} (${body.status})`, { refType: 'dsr', refId: dsr._id });

    logActivity(req.user, `logged DSR call ${dsrNo} for agent ${agent.employeeId} — Company: ${body.company}, Status: ${body.status}, Contact: ${body.contactNo}`);
    res.status(201).json({ data: dsr });
  } catch (err) {
    next(err);
  }
}

async function updateStatus(req, res, next) {
  try {
    const parsed = statusUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);

    const dsr = await Dsr.findById(req.params.id);
    if (!dsr) throw new AppError('DSR not found', 404);

    const allowedToEdit = req.user.role === 'admin' || String(dsr.agentId) === String(req.user._id);
    if (!allowedToEdit) throw new AppError('You cannot edit this DSR', 403);
    if (req.user.role !== 'admin' && (await isSentToBackOffice(dsr))) {
      throw new AppError('This deal has been sent to Back Office — the DSR record can no longer be edited', 400);
    }

    const before = { status: dsr.status, remarks: dsr.remarks };
    dsr.status = parsed.data.status;
    if (parsed.data.remarks !== undefined) dsr.remarks = parsed.data.remarks;
    dsr.connected = connectedFor(dsr.status);
    dsr.history.push({ userId: req.user._id, text: `Status updated to ${dsr.status}` });
    await dsr.save();

    const changes = diffFields(before, { status: dsr.status, remarks: dsr.remarks }, DSR_FIELD_LABELS);
    if (changes.length) logActivity(req.user, `updated status on DSR ${dsr.dsrNo}: ${changes.join(', ')}`);
    res.json({ data: dsr });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);

    const dsr = await Dsr.findById(req.params.id);
    if (!dsr) throw new AppError('DSR not found', 404);

    const allowedToEdit = req.user.role === 'admin' || String(dsr.agentId) === String(req.user._id);
    if (!allowedToEdit) throw new AppError('You cannot edit this DSR', 403);
    if (req.user.role !== 'admin' && (await isSentToBackOffice(dsr))) {
      throw new AppError('This deal has been sent to Back Office — the DSR record can no longer be edited', 400);
    }

    const fields = parsed.data;
    const before = {};
    Object.keys(DSR_FIELD_LABELS).forEach((k) => { before[k] = dsr[k]; });
    Object.assign(dsr, fields);
    if (fields.status) {
      dsr.connected = connectedFor(dsr.status);
    }
    dsr.history.push({ userId: req.user._id, text: 'DSR record edited' });
    await dsr.save();

    const changes = diffFields(before, dsr.toObject(), DSR_FIELD_LABELS);
    if (changes.length) logActivity(req.user, `edited DSR ${dsr.dsrNo}: ${changes.join(', ')}`);
    res.json({ data: dsr });
  } catch (err) {
    next(err);
  }
}

// Powers the Company autocomplete in the "Log a call" form — an agent calling the same
// building/customer again shouldn't have to retype Building/Contact/Email from scratch. Scoped
// to whatever this user can already see (their own calls, or their team's).
async function autocomplete(req, res, next) {
  try {
    const filter = { ...scopeFilter(req.user) };
    const q = (req.query.q || '').trim();
    if (q) filter.company = new RegExp(q, 'i');

    const rows = await Dsr.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .select('company building contactNo email customer')
      .lean();

    const seen = new Set();
    const suggestions = [];
    for (const r of rows) {
      const key = r.company.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(r);
      if (suggestions.length >= 8) break;
    }
    res.json({ data: suggestions });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const dsr = await Dsr.findOne({ _id: req.params.id, ...scopeFilter(req.user) }).populate('agentId', 'name').lean();
    if (!dsr) throw new AppError('DSR not found', 404);
    res.json({ data: dsr });
  } catch (err) {
    next(err);
  }
}

const EXPORT_COLUMNS = [
  { header: 'DSR No', key: 'dsrNo' },
  { header: 'Date', get: (r) => isoToDmy(r.date) },
  { header: 'Company', key: 'company' },
  { header: 'Building', key: 'building' },
  { header: 'Contact No', key: 'contactNo' },
  { header: 'Email', key: 'email' },
  { header: 'Customer', key: 'customer' },
  { header: 'Status', key: 'status' },
  { header: 'Connected', key: 'connected' },
  { header: 'Remarks', key: 'remarks' },
  { header: 'Agent', get: (r) => r.agentId?.name || '' },
  { header: 'Agent Email', get: (r) => r.agentId?.email || '' },
  { header: 'Agent Username', get: (r) => r.agentId?.username || '' },
];

async function exportDsr(req, res, next) {
  try {
    const filter = { ...scopeFilter(req.user) };
    if (req.query.status) filter.status = req.query.status;
    const rows = await Dsr.find(filter).sort({ createdAt: -1 }).populate('agentId', 'name email username').lean();
    sendXlsx(res, `dsr-export-${Date.now()}.xlsx`, rows, EXPORT_COLUMNS, 'DSR');
  } catch (err) {
    next(err);
  }
}

// Import rows come from a human-edited spreadsheet, not the app's own <input type="date">, so
// the date is checked strictly instead of just "non-empty" — Excel silently reformats a
// date-typed cell to whatever the file's locale display format is, and every date-range report
// in this app (Dashboard/MIS/AI) compares this field as a plain ISO string, so a bad value here
// doesn't fail loudly, it just quietly reports wrong. Spreadsheets are filled in DD-MM-YYYY
// (matching how the team actually types dates), converted to the app's internal YYYY-MM-DD here.
const DMY_DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;

function parseImportDate(raw) {
  const m = String(raw).trim().match(DMY_DATE_RE);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(Number(yyyy), month, 0).getDate();
  if (day < 1 || day > daysInMonth) return null;
  return `${yyyy}-${mm}-${dd}`;
}

// Export mirrors the import format (DD-MM-YYYY) so a file round-trips: export, edit in Excel,
// re-import, without anyone having to reformat the Date column by hand.
function isoToDmy(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return iso || '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

// Case-insensitive lookup so a stray autocapitalize in Excel ("interested" vs "Interested")
// doesn't fail the whole row - resolved back to the exact enum value the schema expects.
const STATUS_BY_LOWER = new Map(CALL_STATUS.map((s) => [s.toLowerCase(), s]));

const importRowSchema = z.object({
  date: z.string().transform((val, ctx) => {
    const parsed = parseImportDate(val);
    if (!parsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Date must be in DD-MM-YYYY format (check the cell wasn\'t auto-reformatted by Excel)' });
      return z.NEVER;
    }
    return parsed;
  }),
  company: z.string().trim().min(1, 'Company is required'),
  building: z.string().optional().default(''),
  contactNo: contactNoSchema,
  email: emailSchema.optional().default(''),
  customer: z.string().optional().default(''),
  status: z.enum(CALL_STATUS, { errorMap: () => ({ message: `Status must be one of: ${CALL_STATUS.join(', ')}` }) }),
  remarks: z.string().optional().default(''),
});

async function importDsr(req, res, next) {
  try {
    if (!req.file) throw new AppError('No file uploaded', 400);
    const rawRows = parseXlsxBuffer(req.file.buffer);
    if (!rawRows.length) throw new AppError('The file has no data rows', 400);

    // A missing Date on even one row usually means the column got dropped, renamed, or the
    // sheet is the wrong one entirely - reject the whole file upfront instead of silently
    // creating everything except that row.
    const missingDateRows = rawRows
      .map((raw, i) => (cell(raw, 'Date') ? null : i + 2))
      .filter((rowNum) => rowNum !== null);
    if (missingDateRows.length) {
      // This detail renders in a scrollable modal alert, not a toast, so it can afford to list
      // a real number of rows - just capped well short of "every row in a 9,000-row file" for
      // files where the whole sheet is missing the column entirely.
      const shown = missingDateRows.slice(0, 100).join(', ');
      const rest = missingDateRows.length > 100 ? ` and ${missingDateRows.length - 100} more` : '';
      throw new AppError(
        `Date is missing on row(s): ${shown}${rest}. Every row must have a Date (DD-MM-YYYY) — no rows were imported.`,
        400
      );
    }

    const errors = [];
    let created = 0;
    let skipped = 0;
    const tlNotifyCounts = new Map(); // tlId -> count, one summary notification per TL instead of one per row

    for (let i = 0; i < rawRows.length; i += 1) {
      const raw = rawRows[i];
      const rowNum = i + 2; // account for the header row
      try {
        const rawStatus = cell(raw, 'Status');
        const candidate = {
          date: cell(raw, 'Date'),
          company: cell(raw, 'Company'),
          building: cell(raw, 'Building'),
          contactNo: cell(raw, 'Contact No'),
          email: cell(raw, 'Email'),
          customer: cell(raw, 'Customer'),
          status: STATUS_BY_LOWER.get(rawStatus.toLowerCase()) || rawStatus,
          remarks: cell(raw, 'Remarks'),
        };

        // Collect every problem with this row in one pass (schema + agent lookup) instead of
        // reporting only the first one - otherwise fixing one issue and re-uploading just
        // reveals the next, and any row already fixed gets re-created as a duplicate.
        const issues = [];
        const parsed = importRowSchema.safeParse(candidate);
        if (!parsed.success) issues.push(parsed.error.issues[0].message);

        const { agent, error: agentError } = await resolveAgentFromRow(raw, req.user, User);
        if (agentError) issues.push(agentError);

        if (issues.length) {
          errors.push({ row: rowNum, message: issues.join('; ') });
          continue;
        }

        const body = parsed.data;

        // Same file re-uploaded (accidentally or on purpose) must not create a second copy of
        // a call that's already logged - match on the natural key a human would recognize as
        // "the same call": this agent, this company/number, this day.
        const existing = await Dsr.findOne({ agentId: agent._id, company: body.company, contactNo: body.contactNo, date: body.date }).select('_id').lean();
        if (existing) {
          skipped += 1;
          continue;
        }

        const seq = await nextSeq('dsr');
        const dsrNo = 'DSR-' + String(seq).padStart(5, '0');
        const chain = agent.managerChain || [];

        await Dsr.create({
          dsrNo,
          ...body,
          connected: connectedFor(body.status),
          agentId: agent._id,
          tlId: chain[0] || null,
          teamHeadId: chain[1] || null,
          salesHeadId: chain[2] || null,
          history: [{ userId: req.user._id, text: `DSR imported from spreadsheet · status set to ${body.status}` }],
        });
        created += 1;
        if (chain[0]) tlNotifyCounts.set(String(chain[0]), (tlNotifyCounts.get(String(chain[0])) || 0) + 1);
      } catch (rowErr) {
        errors.push({ row: rowNum, message: rowErr.message || 'Unexpected error' });
      }
    }

    // One summary per TL, not one per imported row - a 50-row import shouldn't flood a TL's
    // notification panel.
    await Promise.all(
      [...tlNotifyCounts.entries()].map(([tlId, count]) =>
        notify(tlId, `${req.user.name} imported ${count} DSR${count === 1 ? '' : 's'} from a spreadsheet`, { refType: 'dsr' })
      )
    );

    logActivity(req.user, `imported DSRs from spreadsheet: ${created} created, ${skipped} skipped (duplicates), ${errors.length} failed, ${rawRows.length} rows total`);
    res.json({ data: { total: rawRows.length, created, skipped, failed: errors.length, errors } });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, updateStatus, update, getOne, exportDsr, importDsr, autocomplete, loggableEmployees };
