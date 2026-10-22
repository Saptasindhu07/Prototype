export function notFound(_req, res) {
  res.status(404).json({ error: { message: 'Route not found.' } });
}

export function errorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);

  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;

  res.status(status).json({
    error: {
      message: status >= 500 ? 'Internal server error.' : 'Invalid request.',
    },
  });
}
