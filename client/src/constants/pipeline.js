// Single source of truth for Pipeline domain constants - was previously copy-pasted verbatim in
// both PipelinePage.jsx and PipelineDealPanel.jsx, which meant a color/label change had to be
// remembered in two places or they'd silently drift apart.

export const PIPE_STAGES = ['10%- Prospect', '30% - Value Prop', '50% - Negotiation', '70% - Finalizing', '90% - Closing', '100% - Deal Won', '0% - Lost'];

export const SR_TYPES = ['MNP', 'FNP', 'NEW'];

export const STAGE_COLOR = {
  '10%- Prospect': 'gray',
  '30% - Value Prop': 'blue',
  '50% - Negotiation': 'yellow',
  '70% - Finalizing': 'orange',
  '90% - Closing': 'teal',
  '100% - Deal Won': 'green',
  '0% - Lost': 'red',
};

export const APPROVAL_COLOR = { none: 'gray', pending_tl: 'yellow', approved: 'green', rejected: 'red' };

// Short badge text (list table) vs a longer descriptive sentence (deal detail panel) - same
// underlying states/colors (APPROVAL_COLOR above), different copy for different contexts.
export const APPROVAL_LABEL = { none: '', pending_tl: 'Pending TL', approved: 'TL Approved', rejected: 'TL Rejected' };

export const APPROVAL_OPTIONS = [
  { value: 'none', label: 'No approval requested' },
  { value: 'pending_tl', label: 'Pending Team Leader' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

export const APPROVAL_INFO = {
  none: { color: APPROVAL_COLOR.none, text: 'No Team Leader approval requested yet.' },
  pending_tl: { color: APPROVAL_COLOR.pending_tl, text: 'Waiting on the Team Leader to approve.' },
  approved: { color: APPROVAL_COLOR.approved, text: 'Approved by Team Leader — order opened for Back Office.' },
  rejected: { color: APPROVAL_COLOR.rejected, text: 'Rejected by Team Leader.' },
};
