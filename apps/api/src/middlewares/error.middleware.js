export function notFound(_req, res) {
  res.status(404).json({ error: { message: 'Route not found.' } });
}

export function errorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);

  if (error.name === 'ValidationError') {
    return res.status(400).json({
      error: {
        message: 'Validation failed.',
        fields: Object.keys(error.errors),
      },
    });
  }

  if (error.code === 11000) {
    return res.status(409).json({ error: { message: 'A record with this unique ID already exists.' } });
  }

  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;

  res.status(status).json({
    error: {
      message: typeof error.publicMessage === 'string' ? error.publicMessage : status >= 500 ? 'Internal server error.' : 'Invalid request.',
    },
  });
}
