const { z } = require('zod');
const Thread = require('../models/Thread');
const Dsr = require('../models/Dsr');
const Pipeline = require('../models/Pipeline');
const Order = require('../models/Order');
const User = require('../models/User');
const { notify } = require('../services/notify');
const AppError = require('../utils/AppError');
const { logActivity } = require('../utils/activityLog');

// Builds the "system" side of the conversation - every history entry already recorded on the
// DSR/Pipeline/Order for this reference number - so the thread reads as one full timeline,
// not just the human chat on top of it.
async function systemEntries(dsrNo) {
  const [dsr, pipeline, order] = await Promise.all([
    Dsr.findOne({ dsrNo }).populate('history.userId', 'name').lean(),
    Pipeline.findOne({ dsrNo }).populate('history.userId', 'name').lean(),
    Order.findOne({ dsrNo }).populate('history.userId', 'name').lean(),
  ]);
  const entries = [];
  (dsr?.history || []).forEach((h) => entries.push({ type: 'sys', stage: 'DSR', text: h.text, ts: h.ts, userName: h.userId?.name || 'System' }));
  (pipeline?.history || []).forEach((h) => entries.push({ type: 'sys', stage: 'Pipeline', text: h.text, ts: h.ts, userName: h.userId?.name || 'System' }));
  (order?.history || []).forEach((h) => entries.push({ type: 'sys', stage: 'Back Office', text: h.text, ts: h.ts, userName: h.userId?.name || 'System' }));
  return { entries, dsr, pipeline, order };
}

function stakeholdersOf(dsr, pipeline, order) {
  const ids = [dsr?.agentId, dsr?.tlId, dsr?.teamHeadId, dsr?.salesHeadId, pipeline?.agentId, pipeline?.tlId, order?.agentId, order?.tlId];
  return [...new Set(ids.filter(Boolean).map(String))];
}

// Restricts thread access to: admins, anyone stamped anywhere in this record's hierarchy
// (agent/TL/Teams Head/Sales Head), and Back Office once an order exists.
function assertThreadAccess(user, dsr, pipeline, order) {
  if (user.role === 'admin') return;
  if (order && user.role === 'backoffice') return;
  const stakeholders = stakeholdersOf(dsr, pipeline, order);
  if (!stakeholders.includes(String(user._id))) {
    throw new AppError('You do not have access to this conversation', 403);
  }
}

// People this specific record's conversation is relevant to - the agent + their whole
// management chain, plus Back Office once an order exists. Used both to notify and to
// populate the "tag someone" chips client-side (agents/TLs can't hit the admin-only /users list).
async function taggablePeople(dsr, pipeline, order) {
  const ids = stakeholdersOf(dsr, pipeline, order);
  const [chainUsers, backOfficeUsers] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('name role').lean(),
    order ? User.find({ role: 'backoffice', active: true }).select('name role').lean() : [],
  ]);
  const byId = new Map();
  [...chainUsers, ...backOfficeUsers].forEach((u) => byId.set(String(u._id), { _id: u._id, name: u.name, role: u.role }));
  return [...byId.values()];
}

async function getThread(req, res, next) {
  try {
    const { dsrNo } = req.params;
    const { entries, dsr, pipeline, order } = await systemEntries(dsrNo);
    if (!dsr && !pipeline && !order) throw new AppError('No record found for this reference number', 404);
    assertThreadAccess(req.user, dsr, pipeline, order);

    const thread = await Thread.findOne({ dsrNo }).populate('messages.userId', 'name').populate('messages.mentions', 'name').lean();
    const human = (thread?.messages || []).map((m) => ({
      type: m.type,
      text: m.text,
      fileName: m.fileName,
      filePath: m.filePath,
      ts: m.ts,
      userId: m.userId?._id,
      userName: m.userId?.name || 'Unknown',
      mentions: (m.mentions || []).map((u) => u.name),
    }));

    const items = [...entries, ...human].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const people = await taggablePeople(dsr, pipeline, order);

    res.json({
      data: {
        dsrNo,
        context: { company: order?.customer || pipeline?.company || dsr?.company || '', status: order?.status || pipeline?.stage || dsr?.status || '' },
        items,
        people,
      },
    });
  } catch (err) {
    next(err);
  }
}

// Shared by postMessage and postAttachment: notifies everyone stamped on this record plus
// anyone explicitly @-tagged, skipping the sender.
async function notifyThreadRecipients({ dsr, pipeline, order, mentionIds, threadId, dsrNo, actor, summary }) {
  const stakeholders = stakeholdersOf(dsr, pipeline, order);
  const recipients = [...new Set([...stakeholders, ...mentionIds])].filter((id) => id !== String(actor._id));
  await Promise.all(
    recipients.map((id) => {
      const tagged = mentionIds.includes(id);
      return notify(id, `${tagged ? `🔔 ${actor.name} tagged you` : `💬 ${actor.name}`} on ${dsrNo}: ${summary}`, {
        refType: 'thread',
        refId: threadId,
      });
    })
  );
}

const postSchema = z.object({
  text: z.string().trim().min(1),
  mentionIds: z.array(z.string()).optional().default([]),
});

async function postMessage(req, res, next) {
  try {
    const parsed = postSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { dsrNo } = req.params;
    const { text, mentionIds } = parsed.data;

    const { dsr, pipeline, order } = await systemEntries(dsrNo);
    if (!dsr && !pipeline && !order) throw new AppError('No record found for this reference number', 404);
    assertThreadAccess(req.user, dsr, pipeline, order);

    const thread = await Thread.findOneAndUpdate(
      { dsrNo },
      { $push: { messages: { userId: req.user._id, type: 'msg', text, mentions: mentionIds } } },
      { new: true, upsert: true }
    );

    await notifyThreadRecipients({ dsr, pipeline, order, mentionIds, threadId: thread._id, dsrNo, actor: req.user, summary: text.slice(0, 60) });
    logActivity(req.user, `posted a message on ${dsrNo}'s conversation: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);

    res.status(201).json({ data: { ok: true } });
  } catch (err) {
    next(err);
  }
}

async function postAttachment(req, res, next) {
  try {
    if (!req.file) throw new AppError('No file uploaded', 400);
    const { dsrNo } = req.params;
    let mentionIds = [];
    try {
      mentionIds = req.body.mentionIds ? JSON.parse(req.body.mentionIds) : [];
    } catch {
      throw new AppError('Invalid mentionIds', 400);
    }

    const { dsr, pipeline, order } = await systemEntries(dsrNo);
    if (!dsr && !pipeline && !order) throw new AppError('No record found for this reference number', 404);
    assertThreadAccess(req.user, dsr, pipeline, order);

    const thread = await Thread.findOneAndUpdate(
      { dsrNo },
      {
        $push: {
          messages: {
            userId: req.user._id,
            type: 'file',
            fileName: req.file.originalname,
            filePath: `/uploads/${req.file.filename}`,
            mentions: mentionIds,
          },
        },
      },
      { new: true, upsert: true }
    );

    await notifyThreadRecipients({
      dsr, pipeline, order, mentionIds, threadId: thread._id, dsrNo, actor: req.user,
      summary: `shared a file — ${req.file.originalname}`,
    });
    logActivity(req.user, `attached a file to ${dsrNo}'s conversation: "${req.file.originalname}"`);

    res.status(201).json({ data: { ok: true } });
  } catch (err) {
    next(err);
  }
}

module.exports = { getThread, postMessage, postAttachment };
