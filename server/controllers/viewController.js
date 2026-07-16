const { VIEW_TRACKED_MODULES, markViewed: markViewedService } = require('../services/recordViews');
const AppError = require('../utils/AppError');

async function markViewed(req, res, next) {
  try {
    const { module, id } = req.params;
    if (!VIEW_TRACKED_MODULES.includes(module)) throw new AppError(`Unknown module: ${module}`, 400);
    await markViewedService(req.user._id, module, id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = { markViewed };
