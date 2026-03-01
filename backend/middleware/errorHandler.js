const logger = require('../config/logger');

function errorHandler(err, req, res, next) {
  logger.error(err.message, { stack: err.stack, path: req.path });

  if (err.isJoi) {
    return res.status(400).json({ error: 'Validation error', details: err.details.map(d => d.message) });
  }

  const status = err.status || 500;
  const message = status < 500 ? err.message : 'Internal server error';
  res.status(status).json({ error: message });
}

function notFound(req, res) {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
}

module.exports = { errorHandler, notFound };
