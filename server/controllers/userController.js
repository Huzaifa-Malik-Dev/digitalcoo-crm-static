const { z } = require('zod');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const User = require('../models/User');
const AssignmentHistory = require('../models/AssignmentHistory');
const { hashPassword } = require('../utils/password');
const { parsePagination, buildPageResponse } = require('../utils/pagination');
const { buildManagerChain, createInitialAssignment, reassignUser } = require('../services/hierarchy');
const { ROLES } = require('../utils/constants');
const { regexOr } = require('../utils/search');
const { buildWorkbook, parseXlsxBuffer, cell } = require('../utils/importExport');
const { uploadDir } = require('../config/env');
const AppError = require('../utils/AppError');
const { nextSeq } = require('../models/Counter');
const { logActivity, diffFields, describeFields } = require('../utils/activityLog');

const EMPLOYEE_FIELD_LABELS = {
  name: 'Name', arabicName: 'Arabic Name', email: 'Email', phone: 'Phone', desig: 'Designation',
  dept: 'Department', target: 'Target', salary: 'Salary', payType: 'Pay Type', join: 'Join Date', status: 'Status',
};
const CREATE_DETAIL_LABELS = { role: 'Role', desig: 'Designation', dept: 'Department', payType: 'Pay Type', target: 'Target', salary: 'Salary' };

// Explicit allowlist for PATCH /users/:id — role/reportsTo/password go through their own
// handling below; everything else (passwordHash, employeeId, username, managerChain, docs,
// tokenVersion, active, ...) must never be settable directly from the request body. Also reused
// by createSchema below so the Add Employee wizard can collect the same fields up front.
const complianceUpdateSchema = z.object({
  dob: z.string().optional(),
  nationality: z.string().optional(),
  uid: z.string().optional(),
  passportNo: z.string().optional(),
  passportExpiry: z.string().optional(),
  visaCompany: z.string().optional(),
  visaFileNumber: z.string().optional(),
  visaIssue: z.string().optional(),
  visaExpiry: z.string().optional(),
  eid: z.string().optional(),
  eidIssue: z.string().optional(),
  eidExpiry: z.string().optional(),
  labourCardNo: z.string().optional(),
  labourCardIssue: z.string().optional(),
  labourCardExpiry: z.string().optional(),
  insuranceIssue: z.string().optional(),
  insuranceExpiry: z.string().optional(),
  legalCaseStatus: z.string().optional(),
  legalCaseNote: z.string().optional(),
  abscondingMohre: z.string().optional(),
  abscondingMohreNote: z.string().optional(),
  abscondingGdrfa: z.string().optional(),
  abscondingGdrfaNote: z.string().optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1),
  arabicName: z.string().optional().default(''),
  username: z.string().trim().min(3).toLowerCase(),
  password: z.string().min(6),
  role: z.enum(Object.keys(ROLES)),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional().default(''),
  desig: z.string().optional().default(''),
  dept: z.string().optional().default(''),
  reportsTo: z.string().nullable().optional(),
  target: z.number().optional().default(0),
  salary: z.number().optional().default(0),
  payType: z.enum(['salary', 'commission', 'salary_commission']).optional().default('salary'),
  join: z.string().optional().default(''),
  compliance: complianceUpdateSchema.optional().default({}),
});

const reassignSchema = z
  .object({
    role: z.enum(Object.keys(ROLES)).optional(),
    reportsTo: z.string().nullable().optional(),
    // Required only when reportsTo is actually present in the request - a pure role change
    // doesn't move anyone's team, so there's nothing to date. See reassignUser for the
    // today-or-earlier + not-before-current-assignment-started validation.
    effectiveDate: z.string().optional(),
  })
  .refine((v) => v.reportsTo === undefined || !!v.effectiveDate, {
    message: 'Assignment date is required when changing an employee\'s team',
    path: ['effectiveDate'],
  });

const STATUS_VALUES = ['Active', 'Inactive', 'Frozen', 'Absconding'];

const updateFieldsSchema = z.object({
  name: z.string().trim().min(1).optional(),
  arabicName: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  desig: z.string().optional(),
  dept: z.string().optional(),
  target: z.number().optional(),
  salary: z.number().optional(),
  payType: z.enum(['salary', 'commission', 'salary_commission']).optional(),
  join: z.string().optional(),
  status: z.enum(STATUS_VALUES).optional(),
  compliance: complianceUpdateSchema.optional(),
});

async function list(req, res, next) {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query);
    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';
    if (req.query.search) {
      const term = req.query.search.trim();
      const matchingRoleKeys = Object.entries(ROLES)
        .filter(([, label]) => label.toLowerCase().includes(term.toLowerCase()))
        .map(([key]) => key);
      filter.$or = [
        ...regexOr(term, ['name', 'username', 'email', 'employeeId', 'desig', 'dept', 'role']),
        ...(matchingRoleKeys.length ? [{ role: { $in: matchingRoleKeys } }] : []),
      ];
    }

    const [data, totalRowCount] = await Promise.all([
      User.find(filter).select('-passwordHash').sort(sort).skip(skip).limit(limit).lean(),
      User.countDocuments(filter),
    ]);

    res.json(buildPageResponse(data, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const user = await User.findById(req.params.id).select('-passwordHash').lean();
    if (!user) throw new AppError('User not found', 404);
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
}

// Human-facing employee pages are linked/shared by employeeId (e.g. "DC16"), not the database
// _id - accepts either the bare number or the full "DC16" (case-insensitive) so a pasted full
// ID still resolves. Internal mutations (update/upload/ledger) still use the real _id, sourced
// from the record this returns - only the initial lookup needs this alternate key.
async function getByEmployeeId(req, res, next) {
  try {
    const raw = req.params.employeeId.trim();
    const employeeId = /^dc/i.test(raw) ? raw.toUpperCase() : `DC${raw}`;
    const user = await User.findOne({ employeeId }).select('-passwordHash').lean();
    if (!user) throw new AppError('Employee not found', 404);
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const body = parsed.data;

    const exists = await User.findOne({ username: body.username });
    if (exists) throw new AppError('Username already taken', 409);

    const passwordHash = await hashPassword(body.password);
    const managerChain = body.reportsTo ? await buildManagerChain(body.reportsTo) : [];
    const employeeId = 'DC' + (await nextSeq('employee'));

    const user = await User.create({
      ...body,
      employeeId,
      passwordHash,
      managerChain,
    });

    await createInitialAssignment(user, req.user._id);

    logActivity(req.user, `added employee ${user.employeeId} (${user.name}) — ${describeFields(user, CREATE_DETAIL_LABELS)}`);
    const { passwordHash: _drop, ...safe } = user.toObject();
    res.status(201).json({ data: safe });
  } catch (err) {
    next(err);
  }
}

// Role/manager changes go through reassignUser so AssignmentHistory stays correct.
// Other profile fields (name, desig, salary, compliance, etc.) are plain field updates.
async function update(req, res, next) {
  try {
    const { role, reportsTo, effectiveDate, password } = req.body;
    const parsedRest = updateFieldsSchema.safeParse(req.body);
    if (!parsedRest.success) throw new AppError(parsedRest.error.issues[0].message, 400);
    const rest = parsedRest.data;
    const isSelf = String(req.params.id) === String(req.user._id);

    const before = await User.findById(req.params.id).select('employeeId name role reportsTo ' + Object.keys(EMPLOYEE_FIELD_LABELS).join(' ')).lean();
    if (!before) throw new AppError('User not found', 404);

    // Nobody can revoke their own access — a demoted/deactivated self could lock the
    // system out of having anyone left to fix it. Someone else (another admin/HR) must do it.
    if (isSelf) {
      if (role !== undefined && role !== req.user.role) {
        throw new AppError('You cannot change your own role - ask another admin or HR to do it', 403);
      }
      if (rest.status !== undefined && rest.status !== 'Active') {
        throw new AppError('You cannot change your own status - ask another admin or HR to do it', 403);
      }
    }

    if (role !== undefined || reportsTo !== undefined) {
      const parsed = reassignSchema.safeParse({ role, reportsTo, effectiveDate });
      if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
      const { movedCounts } = await reassignUser(req.params.id, parsed.data, req.user._id);
      if (role !== undefined && role !== before.role) {
        logActivity(req.user, `changed employee ${before.employeeId} (${before.name})'s role: ${before.role} -> ${role}`);
      }
      if (reportsTo !== undefined && String(reportsTo || '') !== String(before.reportsTo || '')) {
        logActivity(
          req.user,
          `reassigned employee ${before.employeeId} (${before.name}) to a new manager effective ${parsed.data.effectiveDate} — moved ${movedCounts.dsr} DSR, ${movedCounts.pipeline} pipeline, ${movedCounts.order} order, ${movedCounts.leave} leave, ${movedCounts.attendance} attendance record(s)`
        );
      }
    }

    if (password) rest.passwordHash = await hashPassword(password);
    // status is the source of truth; active is a derived flag every rollup/login-gate already reads.
    if (rest.status !== undefined) rest.active = rest.status === 'Active';

    const user = await User.findByIdAndUpdate(req.params.id, rest, { new: true }).select('-passwordHash');
    if (!user) throw new AppError('User not found', 404);

    const changes = diffFields(before, user.toObject(), EMPLOYEE_FIELD_LABELS);
    if (changes.length) logActivity(req.user, `edited employee ${before.employeeId} (${before.name}): ${changes.join(', ')}`);
    if (password) logActivity(req.user, `reset employee ${before.employeeId} (${before.name})'s password`);
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
}

const UPLOAD_DOC_FIELDS = [
  'profilePic',
  'passportImgF',
  'passportImgB',
  'visaImgF',
  'visaImgB',
  'eidImgF',
  'eidImgB',
  'labourCardImg',
  'insuranceImgF',
  'insuranceImgB',
  'legalCaseDoc',
  'abscondingMohreDoc',
  'abscondingGdrfaDoc',
];

async function uploadDoc(req, res, next) {
  try {
    const { field } = req.params;
    if (!UPLOAD_DOC_FIELDS.includes(field)) throw new AppError('Unknown document field', 400);
    if (!req.file) throw new AppError('No file uploaded', 400);

    const user = await User.findById(req.params.id);
    if (!user) throw new AppError('User not found', 404);

    user.docs[field] = `/uploads/${req.file.filename}`;
    await user.save();

    logActivity(req.user, `uploaded ${field} document for employee ${user.employeeId} (${user.name})`);
    res.json({ data: { field, path: user.docs[field] } });
  } catch (err) {
    next(err);
  }
}

// Single source of truth for HR export column headers <-> field names, so exportEmployees and
// importEmployees can never drift out of sync with each other (import looks up cells by these
// exact headers).
const EMPLOYEE_EXPORT_FIELDS = [
  { header: 'Name', field: 'name', scope: 'top' },
  { header: 'Arabic Name', field: 'arabicName', scope: 'top' },
  { header: 'Email', field: 'email', scope: 'top' },
  { header: 'Phone', field: 'phone', scope: 'top' },
  { header: 'Designation', field: 'desig', scope: 'top' },
  { header: 'Department', field: 'dept', scope: 'top' },
  { header: 'Join Date', field: 'join', scope: 'top' },
  { header: 'Target (AED)', field: 'target', scope: 'topNumeric' },
  { header: 'Salary (AED)', field: 'salary', scope: 'topNumeric' },
  { header: 'UID', field: 'uid', scope: 'compliance' },
  { header: 'Date of Birth', field: 'dob', scope: 'compliance' },
  { header: 'Nationality', field: 'nationality', scope: 'compliance' },
  { header: 'Passport No', field: 'passportNo', scope: 'compliance' },
  { header: 'Passport Expiry', field: 'passportExpiry', scope: 'compliance' },
  { header: 'Visa Company', field: 'visaCompany', scope: 'compliance' },
  { header: 'Visa File Number', field: 'visaFileNumber', scope: 'compliance' },
  { header: 'Visa Issue Date', field: 'visaIssue', scope: 'compliance' },
  { header: 'Visa Expiry', field: 'visaExpiry', scope: 'compliance' },
  { header: 'Emirates ID', field: 'eid', scope: 'compliance' },
  { header: 'Emirates ID Issue', field: 'eidIssue', scope: 'compliance' },
  { header: 'Emirates ID Expiry', field: 'eidExpiry', scope: 'compliance' },
  { header: 'Labour Card No', field: 'labourCardNo', scope: 'compliance' },
  { header: 'Labour Card Issue', field: 'labourCardIssue', scope: 'compliance' },
  { header: 'Labour Card Expiry', field: 'labourCardExpiry', scope: 'compliance' },
  { header: 'Insurance Issue', field: 'insuranceIssue', scope: 'compliance' },
  { header: 'Insurance Expiry', field: 'insuranceExpiry', scope: 'compliance' },
  { header: 'Legal Case Status', field: 'legalCaseStatus', scope: 'compliance' },
  { header: 'Legal Case Note', field: 'legalCaseNote', scope: 'compliance' },
  { header: 'Absconding MOHRE', field: 'abscondingMohre', scope: 'compliance' },
  { header: 'Absconding MOHRE Note', field: 'abscondingMohreNote', scope: 'compliance' },
  { header: 'Absconding GDRFA', field: 'abscondingGdrfa', scope: 'compliance' },
  { header: 'Absconding GDRFA Note', field: 'abscondingGdrfaNote', scope: 'compliance' },
];

const EXPORT_COLUMNS = [
  { header: 'Employee ID', key: 'employeeId' },
  { header: 'Username', key: 'username' },
  { header: 'Role', get: (r) => ROLES[r.role] || r.role },
  { header: 'Status', key: 'status' },
  ...EMPLOYEE_EXPORT_FIELDS.map((f) => ({
    header: f.header,
    get: (r) => (f.scope === 'compliance' ? r.compliance?.[f.field] ?? '' : r[f.field] ?? ''),
  })),
];

const ZIP_DOC_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];

// Bulk export of every employee as a ZIP: data.xlsx (all fields) + docs/<Employee ID>/<field>.<ext>
// for every uploaded document image/PDF currently on disk for that employee.
async function exportEmployees(req, res, next) {
  try {
    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';

    const users = await User.find(filter).select('-passwordHash').lean();

    const zip = new AdmZip();
    zip.addFile('data.xlsx', buildWorkbook(users, EXPORT_COLUMNS, 'Employees'));

    users.forEach((u) => {
      const docs = u.docs || {};
      UPLOAD_DOC_FIELDS.forEach((field) => {
        const relPath = docs[field];
        if (!relPath) return;
        const absPath = path.join(__dirname, '..', uploadDir, path.basename(relPath));
        if (!fs.existsSync(absPath)) return;
        zip.addLocalFile(absPath, `docs/${u.employeeId}`, `${field}${path.extname(absPath)}`);
      });
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="employees-export-${Date.now()}.zip"`);
    res.send(zip.toBuffer());
  } catch (err) {
    next(err);
  }
}

// Bulk update of existing employees from a ZIP produced by exportEmployees (or matching its
// layout). Update-only, matched by Employee ID — never creates new employees, that has its own
// dedicated Add Employee flow with password/role setup. Only non-empty cells and matched document
// files are applied, so a partially-filled spreadsheet never blanks out fields it didn't touch.
async function importEmployees(req, res, next) {
  try {
    if (!req.file) throw new AppError('No file uploaded', 400);

    let zip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch {
      throw new AppError('The uploaded file is not a valid ZIP', 400);
    }

    const entries = zip.getEntries();
    const dataEntry = entries.find((e) => !e.isDirectory && /(^|\/)data\.xlsx$/i.test(e.entryName));
    if (!dataEntry) throw new AppError('ZIP must contain a data.xlsx file', 400);

    const rawRows = parseXlsxBuffer(dataEntry.getData());
    if (!rawRows.length) throw new AppError('data.xlsx has no data rows', 400);

    const errors = [];
    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < rawRows.length; i += 1) {
      const raw = rawRows[i];
      const rowNum = i + 2;
      try {
        const employeeId = cell(raw, 'Employee ID');
        if (!employeeId) {
          skipped += 1;
          continue;
        }

        const user = await User.findOne({ employeeId });
        if (!user) {
          errors.push({ row: rowNum, message: `No employee found with Employee ID "${employeeId}"` });
          continue;
        }

        EMPLOYEE_EXPORT_FIELDS.forEach(({ header, field, scope }) => {
          const v = cell(raw, header);
          if (!v) return;
          if (scope === 'topNumeric') {
            const n = Number(v);
            if (!Number.isNaN(n)) user[field] = n;
          } else if (scope === 'compliance') {
            user.compliance[field] = v;
          } else {
            user[field] = v;
          }
        });

        const statusVal = cell(raw, 'Status');
        if (statusVal && STATUS_VALUES.includes(statusVal)) {
          user.status = statusVal;
          user.active = statusVal === 'Active';
        }

        // Pull matching document files for this employee out of the zip, laid out the same way
        // exportEmployees produces them: docs/<Employee ID>/<field>.<ext>.
        const folder = `docs/${employeeId}/`.toLowerCase();
        UPLOAD_DOC_FIELDS.forEach((field) => {
          const entry = entries.find(
            (e) =>
              !e.isDirectory &&
              e.entryName.toLowerCase().startsWith(folder) &&
              path.basename(e.entryName).toLowerCase().startsWith(field.toLowerCase())
          );
          if (!entry) return;
          const ext = path.extname(entry.entryName).toLowerCase();
          if (!ZIP_DOC_EXT.includes(ext)) return;
          const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
          fs.writeFileSync(path.join(__dirname, '..', uploadDir, filename), entry.getData());
          user.docs[field] = `/uploads/${filename}`;
        });

        await user.save();
        updated += 1;
      } catch (rowErr) {
        errors.push({ row: rowNum, message: rowErr.message || 'Unexpected error' });
      }
    }

    logActivity(req.user, `imported employee updates from ZIP: ${updated} updated, ${skipped} skipped, ${errors.length} failed, ${rawRows.length} rows total`);
    res.json({ data: { total: rawRows.length, updated, skipped, failed: errors.length, errors } });
  } catch (err) {
    next(err);
  }
}

// Doc types tracked for expiry health — key/label drive the HR Dashboard tiles, field is the
// compliance.* expiry column each one reads from. noField/issueField (where the schema has them)
// feed the detail page so it's a real record (document number, issue date), not just a name and
// a date.
const EXPIRY_CATEGORIES = [
  { key: 'passport', label: 'Passport', field: 'passportExpiry', noField: 'passportNo' },
  { key: 'visa', label: 'Visa', field: 'visaExpiry', noField: 'visaFileNumber', issueField: 'visaIssue' },
  { key: 'eid', label: 'Emirates ID', field: 'eidExpiry', noField: 'eid', issueField: 'eidIssue' },
  { key: 'labourCard', label: 'Labour Card (MOHRE)', field: 'labourCardExpiry', noField: 'labourCardNo', issueField: 'labourCardIssue' },
  { key: 'insurance', label: 'Insurance', field: 'insuranceExpiry', issueField: 'insuranceIssue' },
];

// Mirrors client/src/features/hr/docHealth.js's 30-day "expiring soon" threshold — kept in sync
// by hand since one runs in the browser and one in Node, but the rule itself (date-string compare,
// today <= expiry <= today+30) is simple enough that duplicating it beats sharing a module across
// the client/server boundary.
function healthLevel(expiry, today, in30Str) {
  if (!expiry) return 'missing';
  if (expiry < today) return 'expired';
  if (expiry <= in30Str) return 'expiring';
  return 'good';
}

// Powers the HR Dashboard tab: for each tracked document type, who's expired and who's expiring
// within 30 days, across every employee (not just active ones — a frozen/inactive employee's
// visa still matters legally). Small dataset (HR headcount, not millions of rows) so a single
// find + in-memory group is simpler and just as fast as an aggregation pipeline.
async function complianceSummary(req, res, next) {
  try {
    const users = await User.find({}).select('employeeId name desig dept role active compliance').lean();

    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date();
    in30.setDate(in30.getDate() + 30);
    const in30Str = in30.toISOString().slice(0, 10);

    const categories = EXPIRY_CATEGORIES.map(({ key, label, field, noField, issueField }) => {
      const expired = [];
      const expiring = [];
      users.forEach((u) => {
        const expiry = u.compliance?.[field];
        const level = healthLevel(expiry, today, in30Str);
        const entry = {
          _id: u._id, employeeId: u.employeeId, name: u.name, expiry,
          desig: u.desig, dept: u.dept, role: u.role, active: u.active,
          docNo: noField ? u.compliance?.[noField] : undefined,
          issueDate: issueField ? u.compliance?.[issueField] : undefined,
        };
        if (level === 'expired') expired.push(entry);
        else if (level === 'expiring') expiring.push(entry);
      });
      expired.sort((a, b) => (a.expiry || '').localeCompare(b.expiry || ''));
      expiring.sort((a, b) => (a.expiry || '').localeCompare(b.expiry || ''));
      return { key, label, expiredCount: expired.length, expiringCount: expiring.length, expired, expiring };
    });

    res.json({
      data: {
        categories,
        totalExpired: categories.reduce((sum, cat) => sum + cat.expiredCount, 0),
        totalExpiring: categories.reduce((sum, cat) => sum + cat.expiringCount, 0),
        employeeCount: users.length,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function history(req, res, next) {
  try {
    const rows = await AssignmentHistory.find({ userId: req.params.id })
      .sort({ startDate: -1 })
      .populate('reportsTo', 'name role')
      .populate('changedBy', 'name')
      .lean();
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getOne, getByEmployeeId, create, update, history, uploadDoc, exportEmployees, importEmployees, complianceSummary };
