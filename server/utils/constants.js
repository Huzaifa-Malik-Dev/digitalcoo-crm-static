// Single source of truth for roles, hierarchy, and workflow enums.
// Order in ROLE_LEVEL matters: index = depth in the org chain (0 = top).
const ROLES = {
  admin: 'Administrator',
  sales_head: 'Sales Head',
  teams_head: 'Teams Head',
  team_leader: 'Team Leader',
  agent: 'Sales Agent',
  backoffice: 'Back Office',
  accountant: 'Accountant',
  hr: 'HR',
};

// The reporting chain roles walk through (agent -> team_leader -> teams_head -> sales_head).
// Used to build managerChain on User save.
const CHAIN_ROLES = ['team_leader', 'teams_head', 'sales_head'];

// Nested permission tree - every module, plus its tabs/functionality, as its own None/View/Edit
// key. A child key (e.g. 'hr.addEmployee') is checked exactly the same way as a top-level module
// key by canView/canEdit - it's just a more specific entry in the same flat view/edit lists, so
// no separate storage or check logic is needed for nesting. Displayed nested under its parent in
// Admin > Permissions.
const PERMISSION_TREE = [
  { key: 'dash', label: 'Dashboard' },
  { key: 'dsr', label: 'DSR — Agent' },
  {
    key: 'pipeline',
    label: 'Sales Pipeline',
    children: [
      { key: 'pipeline.approve', label: 'Approve / Reject Deals (Team Leader)' },
      { key: 'pipeline.approveCancellation', label: 'Approve / Reject Order Cancellation (Sales Head)' },
    ],
  },
  {
    key: 'backoffice',
    label: 'Back Office / Orders',
    children: [{ key: 'backoffice.statusChange', label: 'Change Order Status' }],
  },
  { key: 'mis', label: 'MIS & Targets' },
  {
    key: 'hr',
    label: 'HR',
    children: [
      { key: 'hr.dashboard', label: 'Dashboard' },
      { key: 'hr.allEmployees', label: 'All Employees' },
      { key: 'hr.activeEmployees', label: 'Active Employees' },
      { key: 'hr.teamAssignment', label: 'Team Assignment' },
      { key: 'hr.addEmployee', label: 'Add Employee' },
    ],
  },
  {
    key: 'payroll',
    label: 'Payroll',
    children: [
      { key: 'payroll.run', label: 'Payroll Run' },
      { key: 'payroll.ledger', label: 'Employee Ledger' },
      { key: 'payroll.process', label: 'Process Payroll Runs' },
      { key: 'payroll.delete', label: 'Delete Payroll Runs' },
      { key: 'payroll.commissionTiers', label: 'Commission Rules' },
    ],
  },
  {
    key: 'accounting',
    label: 'Accounting',
    children: [
      { key: 'accounting.chartOfAccounts', label: 'Chart of Accounts & Banking' },
      { key: 'accounting.expenses', label: 'Company Expenses' },
      { key: 'accounting.cheques', label: 'Cheques' },
      { key: 'accounting.journal', label: 'Journal Entries' },
      { key: 'accounting.reports', label: 'Financial Reports' },
    ],
  },
  {
    key: 'leave',
    label: 'Leave',
    children: [
      { key: 'leave.approve', label: 'Approve / Reject Team Leave' },
      { key: 'leave.settings', label: 'Leave Types & Holidays' },
    ],
  },
  {
    key: 'attendance',
    label: 'Attendance',
    children: [{ key: 'attendance.manage', label: 'Mark Attendance (HR/Admin)' }],
  },
  { key: 'ai', label: 'AI Reports' },
  { key: 'products', label: 'Products' },
  { key: 'admin', label: 'Admin / Settings' },
];

const MODULES = PERMISSION_TREE.map((m) => m.key);
const ALL_PERMISSION_KEYS = PERMISSION_TREE.flatMap((m) => [m.key, ...(m.children || []).map((c) => c.key)]);

// Every role gets 'leave' and 'attendance' view access - unlike every other module, these are
// company-wide self-service (everyone has their own leave/attendance to look at), not
// role-restricted.
const MODULE_ACCESS_DEFAULT = {
  admin: ['dash', 'dsr', 'pipeline', 'backoffice', 'mis', 'hr', 'payroll', 'accounting', 'leave', 'attendance', 'ai', 'products', 'admin'],
  sales_head: ['dash', 'pipeline', 'mis', 'leave', 'attendance', 'ai', 'products'],
  teams_head: ['dash', 'pipeline', 'mis', 'leave', 'attendance', 'ai', 'products'],
  team_leader: ['dash', 'dsr', 'pipeline', 'mis', 'leave', 'attendance', 'ai', 'products'],
  agent: ['dash', 'dsr', 'pipeline', 'leave', 'attendance', 'products'],
  backoffice: ['dash', 'backoffice', 'mis', 'leave', 'attendance', 'ai', 'products'],
  accountant: ['dash', 'accounting', 'payroll', 'leave', 'attendance', 'ai'],
  hr: ['dash', 'hr', 'payroll', 'leave', 'attendance', 'ai'],
};

// 'leave' edit = can request/cancel their own leave - granted to every role, same reasoning as
// above. 'attendance' edit (marking the register) stays admin/hr-only.
const MODULE_EDIT_DEFAULT = {
  admin: ['dsr', 'pipeline', 'backoffice', 'hr', 'payroll', 'accounting', 'leave', 'attendance', 'products', 'admin'],
  sales_head: ['pipeline', 'leave'],
  teams_head: ['pipeline', 'leave'],
  team_leader: ['dsr', 'pipeline', 'leave'],
  agent: ['dsr', 'pipeline', 'leave'],
  backoffice: ['backoffice', 'leave'],
  accountant: ['payroll', 'accounting', 'leave'],
  // 'payroll' here only unlocks payroll.commissionTiers below - every other payroll edit action
  // (process/delete/ledger) stays admin/accountant-only via SENSITIVE_ACTION_GRANTS stripping it
  // back out for any role not explicitly listed there.
  hr: ['payroll', 'leave', 'attendance'],
};

// A role that can view/edit a module gets every tab under it by default too (admin can narrow
// this later in Permissions) - EXCEPT the small set of dangerous action children below, which
// stay locked down even for someone with full module edit, until explicitly granted.
function expandWithChildren(moduleAccessByRole) {
  const out = {};
  Object.keys(moduleAccessByRole).forEach((role) => {
    const set = new Set();
    moduleAccessByRole[role].forEach((key) => {
      set.add(key);
      const section = PERMISSION_TREE.find((m) => m.key === key);
      (section?.children || []).forEach((c) => set.add(c.key));
    });
    out[role] = [...set];
  });
  return out;
}

// Restrictive edit-only overrides for specific dangerous actions - having module edit is not
// enough on its own, matching the previous standalone "actions" permission axis.
const SENSITIVE_ACTION_GRANTS = {
  'hr.addEmployee': ['admin', 'hr'],
  'payroll.process': ['admin', 'accountant'],
  'payroll.delete': ['admin'],
  'payroll.ledger': ['admin', 'accountant'],
  'payroll.commissionTiers': ['admin', 'hr'],
  'pipeline.approve': ['admin', 'sales_head', 'teams_head', 'team_leader'],
  // Narrower than pipeline.approve's full chain — cancellation sign-off is scoped specifically to
  // the order's own snapshotted salesHeadId (checked per-request in workflow.js), not the whole
  // manager chain, so only Sales Head (and admin) can even reach the endpoint at all.
  'pipeline.approveCancellation': ['admin', 'sales_head'],
  'backoffice.statusChange': ['admin', 'backoffice'],
  // The actual "is this really their manager" check happens per-request in services/leave.js
  // (isAuthorizedApprover walks the employee's whole managerChain) - this just gates who can
  // reach the approval UI/endpoints at all, same two-layer pattern pipeline.approve already uses.
  'leave.approve': ['admin', 'hr', 'team_leader', 'teams_head', 'sales_head'],
  'leave.settings': ['admin', 'hr'],
  'attendance.manage': ['admin', 'hr'],
};

const ACCESS_DEFAULT = expandWithChildren(MODULE_ACCESS_DEFAULT);
const EDIT_ACCESS_DEFAULT = expandWithChildren(MODULE_EDIT_DEFAULT);

Object.keys(ROLES).forEach((role) => {
  Object.entries(SENSITIVE_ACTION_GRANTS).forEach(([key, grantedRoles]) => {
    if (!grantedRoles.includes(role)) {
      EDIT_ACCESS_DEFAULT[role] = (EDIT_ACCESS_DEFAULT[role] || []).filter((k) => k !== key);
    }
  });
});

// Matches how agents actually log call outcomes (from the working reference trackers), grouped
// loosely positive -> follow-up -> not-reached -> negative. Order here drives the dropdown order
// on the frontend too, so the common ones agents pick most aren't buried alphabetically.
const CALL_STATUS = [
  'Interested', 'FollowUp', '10% Followup Customer', 'Given to TL Followup', 'Connected', 'Lead Generated',
  'Call back later', 'Online meeting', 'Visited Face to Face', 'Cold calling visit',
  'Using etisalat', 'Using DU',
  'No answer', 'Voicemail', 'Not Connected', 'Switch off', 'No response', 'Number not in use',
  'Not interested',
];

// Statuses where the agent never actually reached/spoke to anyone - used to auto-derive the
// `connected` YES/NO flag on a DSR record.
const NOT_CONNECTED_STATUSES = ['No answer', 'Voicemail', 'Number not in use', 'Not Connected', 'Switch off', 'No response'];

// Percentage sales-progress stages - matches the original prototype and the real trackers
// exactly (agents/TLs move a deal through these directly; this is separate from the TL
// approval workflow, see APPROVAL_STATUS below).
const PIPE_STAGES = ['10%- Prospect', '30% - Value Prop', '50% - Negotiation', '70% - Finalizing', '90% - Closing', '100% - Deal Won', '0% - Lost'];


// The optional TL sign-off workflow - independent of the deal's sales-progress stage. An agent
// can ask their TL to review/approve a deal at any point; reaching 100% also opens an order
// regardless of approval state. See services/workflow.js.
const APPROVAL_STATUS = ['none', 'pending_tl', 'approved', 'rejected'];

// Flat fields a Pipeline deal must have filled in (and saved) before Team Leader approval can be
// requested. Line-item completeness (category/product/subscription type/price/qty per block/row)
// is no longer flat - it's checked separately by workflow.missingPipelineFields against
// pipeline.lineItems. `director` is deliberately excluded - it's the one optional field. Shared by
// pipelineController's updateSchema (client can't save the deal without these) and
// services/workflow.escalateToTL (client can't request approval without these) so the two
// enforcement points can never drift apart. The client keeps its own mirror of this list purely
// for instant UI feedback (disabled button + inline field errors) - this is the actual source of truth.
const PIPELINE_REQUIRED_FOR_APPROVAL = {
  email: 'Customer Email', expectedCloseDate: 'Expected Close Date', remarks: 'Remarks',
};

// The successor to 'In Line'/'Not In Line' (removed from ORDER_STATUS below) - see Order.linked
// and workflow.setOrderLinked. Split into its own field because it's a reconciliation check made
// only once an order is done, not a fulfillment-lifecycle status.
const LINKED_STATUS = ['Linked', 'Not Linked'];

// Statuses at which `linked` becomes settable - "post-completion", per the business rule.
const ORDER_DONE_STATUSES = ['Activated', 'Closed'];

const ORDER_STATUS = ['New', 'E& In-process', 'On Hold', 'Activated', 'Closed', 'Cancelled'];

// e&'s own processing status for the order - independent of ORDER_STATUS (this app's internal
// fulfillment workflow) and independent of the correction-request lock (which the Back Office UI
// separately labels "Correction Pending", never "On Hold", to avoid confusion with this real,
// selectable status value). Assigned by Back Office once they have visibility into e&'s side.
const ETISALAT_STATUS = ['Submitted', 'In Progress', 'On Hold', 'Pending for delivery', 'Activated', 'Rejected', 'Closed'];

// Modules that support bulk Import/Export of records (from the real Excel trackers). Kept as its
// own axis from view/edit - a user can be able to see and edit a module's records one-by-one in
// the UI without being allowed to bulk-import/export the underlying data.
const IMPORT_EXPORT_MODULES = ['dsr', 'pipeline', 'backoffice', 'hr'];

// Nobody gets import/export by default except admin - it's a bulk data operation (can move a lot
// of records/PII at once), so every other role has to be explicitly granted it per module via
// Admin > Permissions rather than inheriting it from view/edit access.
// UAE employment compliance flags (HR / Employee profile) — simple Yes/No, not a status enum;
// an optional supporting document can be attached whenever the answer is "Yes" (see docsSchema's
// legalCaseDoc / abscondingMohreDoc / abscondingGdrfaDoc in models/User.js).
const ABSCONDING_STATUS = ['No', 'Yes'];
const LEGAL_CASE_STATUS = ['No', 'Yes'];

// AI Reports page - narrative report types available for the real-LLM async job. 'team' is
// restricted to roles with visibility across more than their own individual production (same
// roles misController treats as "sees everyone/their whole team" for its own rollups).
const AI_REPORT_TYPES = ['performance', 'pipeline', 'financial', 'team'];
const AI_TEAM_REPORT_ROLES = ['admin', 'sales_head', 'teams_head', 'team_leader', 'backoffice'];

const IMPORT_EXPORT_DEFAULT = {
  admin: ['dsr', 'pipeline', 'backoffice', 'hr'],
  sales_head: [],
  teams_head: [],
  team_leader: [],
  agent: [],
  backoffice: [],
  accountant: [],
  hr: [],
};

module.exports = {
  ROLES,
  CHAIN_ROLES,
  PERMISSION_TREE,
  MODULES,
  ALL_PERMISSION_KEYS,
  ACCESS_DEFAULT,
  EDIT_ACCESS_DEFAULT,
  CALL_STATUS,
  NOT_CONNECTED_STATUSES,
  PIPE_STAGES,
  APPROVAL_STATUS,
  PIPELINE_REQUIRED_FOR_APPROVAL,
  ORDER_STATUS,
  LINKED_STATUS,
  ORDER_DONE_STATUSES,
  ETISALAT_STATUS,
  IMPORT_EXPORT_MODULES,
  IMPORT_EXPORT_DEFAULT,
  ABSCONDING_STATUS,
  LEGAL_CASE_STATUS,
  AI_REPORT_TYPES,
  AI_TEAM_REPORT_ROLES,
};
